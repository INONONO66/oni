//! Frame shaping after capture: in-place crop, box-filter resample and the
//! encode loop that shrinks a frame until its encoding fits the byte cap.

use std::ops::Range;

use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    ExtendedColorType, ImageEncoder,
};

use super::Fault;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Png,
    Jpeg,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
        }
    }

    fn channels(self) -> usize {
        match self {
            Self::Png => 4,
            Self::Jpeg => 3,
        }
    }
}

pub struct Encoding {
    pub format: Format,
    pub quality: u8,
    pub max_bytes: usize,
    pub max_dimension: u32,
}

pub struct Fitted {
    pub width: u32,
    pub height: u32,
    pub downscaled: bool,
}

/// Keeps `columns` x `rows` of an RGBA8 frame `width` pixels wide, moving
/// rows forward in place; returns the cropped size.
pub fn crop(pixels: &mut Vec<u8>, width: u32, columns: Range<u32>, rows: Range<u32>) -> (u32, u32) {
    let stride = width as usize * 4;
    let row = columns.len() * 4;
    for (out, source) in rows.clone().enumerate() {
        let from = source as usize * stride + columns.start as usize * 4;
        pixels.copy_within(from..from + row, out * row);
    }
    pixels.truncate(rows.len() * row);
    (columns.len() as u32, rows.len() as u32)
}

fn span(index: u32, target: u32, source: u32) -> Range<u64> {
    let start = u64::from(index) * u64::from(source) / u64::from(target);
    let end = (u64::from(index + 1) * u64::from(source) / u64::from(target)).max(start + 1);
    start..end
}

/// Box-filter resample of an RGBA8 frame into `channels` (4 = RGBA, 3 = RGB):
/// each output pixel averages the source pixels it covers.
fn resample(
    source: &[u8],
    size: (u32, u32),
    target: (u32, u32),
    channels: usize,
    out: &mut Vec<u8>,
) {
    out.clear();
    out.reserve(target.0 as usize * target.1 as usize * channels);
    for y in 0..target.1 {
        let rows = span(y, target.1, size.1);
        for x in 0..target.0 {
            let columns = span(x, target.0, size.0);
            let mut sum = [0u64; 4];
            for row in rows.clone() {
                for column in columns.clone() {
                    let at = (row * u64::from(size.0) + column) as usize * 4;
                    for (total, byte) in sum.iter_mut().zip(&source[at..at + 4]) {
                        *total += u64::from(*byte);
                    }
                }
            }
            let count = (rows.end - rows.start) * (columns.end - columns.start);
            out.extend(
                sum[..channels]
                    .iter()
                    .map(|total| ((total + count / 2) / count) as u8),
            );
        }
    }
}

fn bounded(width: u32, height: u32, max: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max {
        return (width, height);
    }
    let side =
        |value: u32| ((u64::from(value) * u64::from(max) / u64::from(longest)) as u32).max(1);
    (side(width), side(height))
}

fn write(
    data: &[u8],
    size: (u32, u32),
    encoding: &Encoding,
    out: &mut Vec<u8>,
) -> Result<(), Fault> {
    out.clear();
    let written = match encoding.format {
        Format::Png => {
            PngEncoder::new(&mut *out).write_image(data, size.0, size.1, ExtendedColorType::Rgba8)
        }
        Format::Jpeg => JpegEncoder::new_with_quality(&mut *out, encoding.quality).write_image(
            data,
            size.0,
            size.1,
            ExtendedColorType::Rgb8,
        ),
    };
    written.map_err(|error| Fault::Failed(error.to_string()))
}

/// Box-scales an RGBA8 frame to fit `max` with even sides (at least 2), as
/// 4:2:0 video requires.
pub fn even(pixels: &[u8], size: (u32, u32), max: u32, out: &mut Vec<u8>) -> (u32, u32) {
    let (width, height) = bounded(size.0, size.1, max);
    let target = ((width & !1).max(2), (height & !1).max(2));
    resample(pixels, size, target, 4, out);
    target
}

/// Encodes an RGBA8 frame, first downscaled to `max_dimension`, then shrunk
/// geometrically (by at most 0.9 per side each round) until the encoding is
/// at most `max_bytes`; a 1x1 frame that still does not fit is refused.
pub fn fit(
    pixels: &[u8],
    size: (u32, u32),
    encoding: &Encoding,
    scratch: &mut Vec<u8>,
    out: &mut Vec<u8>,
) -> Result<Fitted, Fault> {
    if size.0 == 0 || size.1 == 0 || pixels.len() != size.0 as usize * size.1 as usize * 4 {
        return Err(Fault::Failed("malformed frame".to_owned()));
    }
    let mut target = bounded(size.0, size.1, encoding.max_dimension);
    loop {
        let channels = encoding.format.channels();
        let data = if target == size && channels == 4 {
            pixels
        } else {
            resample(pixels, size, target, channels, scratch);
            scratch.as_slice()
        };
        write(data, target, encoding, out)?;
        if out.len() <= encoding.max_bytes {
            return Ok(Fitted {
                width: target.0,
                height: target.1,
                downscaled: target != size,
            });
        }
        if target == (1, 1) {
            return Err(Fault::Failed(format!(
                "encoded frame exceeds {} bytes",
                encoding.max_bytes
            )));
        }
        let factor = (encoding.max_bytes as f64 / out.len() as f64)
            .sqrt()
            .min(0.9);
        let shrink = |side: u32| ((f64::from(side) * factor) as u32).max(1);
        target = (shrink(target.0), shrink(target.1));
    }
}

#[cfg(test)]
mod tests {
    use super::{write, Encoding, Fault, Format};

    #[test]
    fn encoder_errors_become_capture_failures() {
        let jpeg = Encoding {
            format: Format::Jpeg,
            quality: 80,
            max_bytes: usize::MAX,
            max_dimension: u32::MAX,
        };
        let wide = vec![0; 70_000 * 3];
        let error = write(&wide, (70_000, 1), &jpeg, &mut Vec::new()).expect_err("too wide");
        assert!(matches!(error, Fault::Failed(message) if !message.is_empty()));
    }
}
