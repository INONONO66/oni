use super::Fault;

pub struct Format {
    pub bits_per_pixel: u8,
    pub scanline_pad: u8,
    pub little_endian: bool,
    pub masks: [u32; 3],
}

pub fn rgba(
    bytes: &[u8],
    pixels: &mut Vec<u8>,
    width: u16,
    height: u16,
    format: &Format,
) -> Result<(u32, u32), Fault> {
    if !matches!(format.bits_per_pixel, 8 | 16 | 24 | 32)
        || !matches!(format.scanline_pad, 8 | 16 | 32)
        || format.masks.contains(&0)
    {
        return Err(Fault::Failed("unsupported X11 pixel format".into()));
    }
    let pixel_bytes = usize::from(format.bits_per_pixel / 8);
    let pad = usize::from(format.scanline_pad / 8);
    let row_bytes = usize::from(width) * pixel_bytes;
    let stride = row_bytes.div_ceil(pad) * pad;
    let length = usize::from(width) * usize::from(height) * 4;
    if bytes.len() < stride * usize::from(height) {
        return Err(Fault::Failed("X11 image is short".into()));
    }
    pixels.clear();
    pixels.reserve(length);
    for row in bytes.chunks_exact(stride).take(usize::from(height)) {
        for pixel in row[..row_bytes].chunks_exact(pixel_bytes) {
            let mut packed = [0; 4];
            let value = if format.little_endian {
                packed[..pixel_bytes].copy_from_slice(pixel);
                u32::from_le_bytes(packed)
            } else {
                packed[4 - pixel_bytes..].copy_from_slice(pixel);
                u32::from_be_bytes(packed)
            };
            for mask in format.masks {
                let component = (value & mask) >> mask.trailing_zeros();
                let maximum = mask >> mask.trailing_zeros();
                // component <= maximum, so the normalized value fits one byte.
                let normalized = u64::from(component) * 255 / u64::from(maximum);
                pixels.push(normalized.to_le_bytes()[0]);
            }
            // Core X11 pixmaps carry RGB, not an alpha channel; unused bits are padding.
            pixels.push(255);
        }
    }
    Ok((u32::from(width), u32::from(height)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_server_order_masks_padding_and_opaque_alpha() {
        let mut result = vec![9];
        let format = Format {
            bits_per_pixel: 32,
            scanline_pad: 32,
            little_endian: true,
            masks: [0xff0000, 0xff00, 0xff],
        };
        assert_eq!(rgba(&[1, 2, 3, 0], &mut result, 1, 1, &format), Ok((1, 1)));
        assert_eq!(result, [3, 2, 1, 255]);
        assert_eq!(
            rgba(&[1, 2, 3], &mut result, 1, 1, &format),
            Err(Fault::Failed("X11 image is short".into()))
        );
        let format = Format {
            bits_per_pixel: 16,
            scanline_pad: 32,
            little_endian: false,
            masks: [0xf800, 0x7e0, 0x1f],
        };
        assert_eq!(
            rgba(
                &[0xf8, 0, 99, 99, 0, 0x1f, 99, 99],
                &mut result,
                1,
                2,
                &format
            ),
            Ok((1, 2))
        );
        assert_eq!(result, [255, 0, 0, 255, 0, 0, 255, 255]);
        assert!(rgba(
            &[],
            &mut result,
            1,
            1,
            &Format {
                bits_per_pixel: 1,
                ..format
            }
        )
        .is_err());
    }
}
