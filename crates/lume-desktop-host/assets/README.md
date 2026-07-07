# Software cursor asset

`official-software-cursor-window-252.png` comes from the MIT-licensed
`open-codex-computer-use` reference repository requested for Lume's computer-use cursor.
The `.bgra` file is the same 252x252 image converted to premultiplied BGRA so the Windows
layered window can render it without a runtime image-decoder dependency.

The cursor motion model in `src/windows_cursor_motion.rs` is also ported from that
repository's heading-driven candidate and spring implementation. See
`LICENSE.open-codex-computer-use` for the upstream license notice.
