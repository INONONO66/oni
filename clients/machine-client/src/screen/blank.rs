use std::collections::HashMap;

pub fn blank(pixels: &[u8]) -> bool {
    let stride = (pixels.len() / 4 / 4096).max(1);
    let mut counts: HashMap<&[u8; 4], usize> = HashMap::new();
    let mut sampled = 0;
    let mut largest = 0;
    for pixel in pixels.as_chunks::<4>().0.iter().step_by(stride) {
        sampled += 1;
        let count = counts.entry(pixel).or_default();
        *count += 1;
        largest = largest.max(*count);
    }
    sampled > 0 && largest * 100 >= sampled * 99
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_dominant_color_at_the_exact_threshold() {
        assert!(!blank(&[]));
        let mut pixels = vec![0; 400];
        pixels[0] = 1;
        assert!(blank(&pixels));
        pixels[4] = 1;
        assert!(!blank(&pixels));
        assert!(blank(&vec![255; 40_000]));
    }
}
