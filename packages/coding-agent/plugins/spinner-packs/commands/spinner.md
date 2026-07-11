---
name: spinner
description: Switch the working-indicator spinner personality pack
---

Change the spinner personality pack used for the working/loading indicator.

Available packs: `default`, `fire`, `ocean`, `matrix`, `synthwave`, `aurora`,
`dots-classic`, `pulse`, `reactive`.

To apply the user's requested pack, set the core setting `display.spinnerPack`
to the chosen value (for example `fire`). Use `default` to restore the theme's
standard spinner and shimmer. The animated gradient sweep follows the
`display.shimmer` setting — when shimmer is `disabled` the pack renders a static
gradient.

If the user did not name a pack, list the options above and ask which they want.
