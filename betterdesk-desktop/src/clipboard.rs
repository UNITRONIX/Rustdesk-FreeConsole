//! Bidirectional text clipboard bridge with a hard payload limit.

use anyhow::Result;

pub const MAX_CLIPBOARD_BYTES: usize = 8 * 1024 * 1024;

pub fn read_text() -> Result<String> {
    let mut clipboard = arboard::Clipboard::new()?;
    let text = clipboard.get_text()?;
    if text.len() > MAX_CLIPBOARD_BYTES {
        anyhow::bail!("clipboard content is too large");
    }
    Ok(text)
}

pub fn write_text(text: &str) -> Result<()> {
    if text.len() > MAX_CLIPBOARD_BYTES {
        anyhow::bail!("clipboard content is too large");
    }
    let mut clipboard = arboard::Clipboard::new()?;
    clipboard.set_text(text.to_owned())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_limit_is_bounded() {
        assert!(write_text(&"x".repeat(MAX_CLIPBOARD_BYTES + 1)).is_err());
    }
}
