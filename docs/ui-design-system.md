# Bifrost terminal design system

Bifrost interfaces help users understand what the router is doing, why, and what they can change. Show the answer first. Distinguish what is active, what is proposed, and what happened. Build on Pi’s theme and controls. Leave its editor and footer intact.

## Foundations

### Hierarchy and spacing

Read from top to bottom: title, primary information, supporting details, then actions. Put warnings next to what they affect. A warning that changes a decision belongs before the action, not in the key hints or behind an expandable row.

Use bold for the title, plain text for values, and short sentence-case labels. Separate groups with one blank line. Keep related rows together without blank lines between them. Use one column of inset inside a frame and two columns between aligned labels and values. The containing view sets spacing between components. Do not add nested frames to separate groups.

When a row no longer fits, put its value on the next line. For long views, scroll the content and keep essential controls reachable. Drop decoration before hiding content. Measure visible terminal columns with Pi utilities. Wrap paths and identifiers without inserting characters into the underlying values.

### Color

Use the active Pi theme. Do not define a second palette or hard-code terminal colors.

| Role | Use |
| --- | --- |
| `text` | Values, body text, and actionable instructions. |
| `muted` | Labels, secondary context, and key hints. |
| `dim` | Decorative separators only. |
| `accent` | The title and focused controls. |
| `border` | An interactive view’s frame. |
| `success` | An outcome known to have succeeded. |
| `warning` | A condition that needs attention but does not necessarily block the task. |
| `error` | A failure or blocked action. |

Pair color with text or a visible state marker. Keep supporting sentences in the normal text color. Do not color proposed additions as successes or proposed removals as failures.

## Components

### Summary panel

Use for a short result or preview that users can read without navigating. The panel contains a title, labeled rows or short paragraphs, and an optional message. Use a single theme-provided background with no outer frame. If the theme does not distinguish the background, keep the title and spacing sufficient to identify the panel.

Keep the panel passive. Put a native Pi confirmation next to the preview when an action requires consent. If users need to browse or expand a substantial amount of information, use an interactive view instead.

### Interactive view

Use for browsing a report or navigating related information. Use one frame with a title, a content area, and a key hint area. Keep persistent actions separate from scrollable content. Use Pi’s native selection or input controls instead if the task is only to choose or enter a value.

Give focus to the first useful control when the view opens. Show the focused row with a marker distinct from the open or closed marker. Keep that row visible on resize and scroll. Closing the view returns control to the originating Pi surface. Do not intercept unrelated host shortcuts.

### Disclosure row

Use to reveal supporting information in place. The row consists of a label, an open or closed marker, and optional summary text. Render the revealed content directly after the row. Use a label such as “Configuration sources,” not “Details.”

Use the host’s navigation and activation bindings where available. Activation toggles the focused row without moving focus. If a parent closes while focus is inside it, return focus to the parent row. Do not add a disclosure marker to a row with no content to reveal.

### Notice

Use for a result or condition that does not need its own view. Start with what happened. Add the affected item or next step when useful. Keep the main message visible even when supporting details are collapsed or the host does not support expansion. Use persistent status only for information that stays relevant across turns.

## Patterns

### Explain a value

Show the effective value next to its source when the source matters. Keep other contributing sources separate from the source of that value. If the value comes from a built-in default or a temporary override, say so. If the source is unknown, do not guess. Keep paths and identifiers accessible at their full length.

### Review and confirm a change

Before asking for confirmation, show what will change, where it will change, and any important side effects. Show the same decision-critical facts in non-TUI confirmations. Do not put those facts only in a widget or in collapsed content. Cancel without applying the proposed change. Report success only after the action succeeds.

### Recover from a problem

Name the affected item and what went wrong. If the user can correct it, give a specific action and retain their input where possible. If the cause or remedy is unknown, state what is known. Distinguish missing data from data that could not be loaded. Use a loading message only while work is active. When no change is needed, say that the current state was kept.

### Copy a report

Offer a labeled copy action only where sharing is useful. The command decides the content, format, and what to omit. Copy the complete intended report regardless of scrolling or expansion. Generate it from report data, not terminal lines. Do not include display styling or terminal control sequences.

Use an explicit list of fields for a shareable report. Exclude credentials and raw prompts. Include local paths or other identifying details only if the report needs them and the user can tell what will be copied. Do not send or save a report as a silent fallback. If the host cannot confirm clipboard success, do not say “Copied.” Offer a safe way to access the same shareable text when possible.

## Composition

A command or view container prepares data, decides which states to present, and owns application actions. It also decides what information is safe to display or copy. Pass structured content and actions to presentation components. Do not parse rendered strings to infer labels, severity, or state.

A presentation component applies layout and theme. It does not read configuration, call providers, or write files. A shared interactive component can own local focus, expansion, and scroll state. Clipboard transport and feedback can be shared independently of the report format. Prefer Pi primitives and extract a Bifrost component when real uses share a contract.

## Acceptance checks

- The primary answer and any decision-critical warning are visible without expansion.
- Keyboard users can reach every action, see focus, and leave the view. Hints match the keys that work.
- Long values remain accessible after resize. Every rendered line fits the available width.
- Text and state remain understandable in light, dark, and limited-color themes.
- Plain-text and RPC output preserve the facts needed to act without relying on visual styling or a widget.
- Where applicable, test cancellation, unavailable data, redaction, and copy failure with deterministic fixtures. Inspect the rendered result in supported Pi versions at narrow and wide widths.
