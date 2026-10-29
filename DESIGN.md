# Michael Router design

## Direction

A personal connection sheet: the care of a printed correspondence sheet with executable details in place of a letter.
The page is a working handoff between developers, not a product dashboard.

The landing surface persuades by making setup immediately usable. Documentation serves reading.
The user's brief supplies product truth and authorizes this replacement design without another interview.
The implementation is code-first. No image is necessary to demonstrate this text-based interface.
The system-font constraint takes precedence over sourcing a display font.

## Visual exploration

Grounded candidates: a connection specification, a pocket field guide, a software release insert, a scientific correspondence sheet, a transit interchange guide, a personal connection sheet, and a specimen catalog.
The direction seed assigns candidate six. The personal sheet supports both a warm invitation and precise commands.
The kiosk challenger contributes disciplined spacing; the transit challenger contributes immediate destinations.
Decorative sea light, textile simulation, and character art do not clarify the first request and are declined.

## First viewport

An oversized serif statement names the four-to-one relationship.
A compact destination list names the providers.
The primary action copies setup and jumps to its command. The command appears below the statement with no enclosing card.
On phones, content stays in this same reading order.

## Type

Display: Georgia, Times New Roman, serif. Fluid 2.75–5.5rem, line-height 1.02, tracking -0.025em.
Documentation titles use a 2.5–4rem display range.
Interface and prose: system sans-serif, 1rem, line-height 1.6. Section headings use 1.5rem; third-level headings use 1.125rem.
Commands and model IDs: ui-monospace, SFMono-Regular, Consolas, monospace; 0.875rem.
Body measure stays below 70 characters. Model IDs have a dedicated line.

## Color tokens

Light: paper #f8fbf9, ink #16382c, secondary #365c4b, accent #086947, rule #b2c9bd.
Dark: paper #10251c, ink #eefaf1, secondary #b3d3c0, accent #82e4af, rule #456b55.
Focus: #a13c16 in light mode and #ffbc91 in dark mode. Code buttons use the pale code text for focus.
Code uses ink green with pale green text in light mode and a deeper green in dark mode.
Secondary text always derives from the green foreground family, including tinted surfaces.

## Space and surfaces

Use 8, 16, 24, 32, 48, and 64px spacing roles.
Keep the setup explanation unboxed. Only executable code receives a filled panel.
Use rules to divide provider sections and catalog groups. Do not nest cards, add icon tiles, or use decorative gradients.
Documentation uses the same type and colors with a narrower reading column.

## Interaction

The single primary control copies the environment setup. Request copy buttons remain secondary.
Copy success and failure use the existing live status message.
Native details disclose request examples and long model lists. Content remains available without JavaScript.
Links, buttons, and summaries have at least 44px targets and a visible focus outline.
Hover and focus change only control color or underline. No entrance animation delays content.
Selection colors, focus rings, and scrollbars use the palette.

## Critique before replacement

1. Setup is deferred behind a scroll action instead of immediately useful.
2. Model IDs wrap mid-name because the label and value share a narrow line.
3. Nested setup and code panels weaken hierarchy.
4. Heavy platform sans type and pale-blue panels resemble a generic template.
5. Four equally weighted command panels make the page longer than the task requires.

## Verification

Require all three pages to pass overflow, hit-target, contrast, request, console, and keyboard checks in both themes.
Check clipboard behavior only where controls exist, including denied-access fallback.
The deterministic detector must report no unresolved source or rendered findings.
