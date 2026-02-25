# Property Panel UI Refactoring Plan

## Background

The current property panel UI implementation significantly differs from the design mockup `attr-ui.html`. This document details the refactoring tasks, ordered by priority from high to low, with the goal of aligning the property panel's visual appearance and interaction experience with the design mockup.

### Reference Files

- **Design Mockup**: `/attr-ui.html`
- **Current Styles**: `ui/shadow-host.ts`
- **Panel Structure**: `ui/property-panel/property-panel.ts`
- **Control Components**: `ui/property-panel/controls/*.ts`

---

## Prerequisite Tasks (Completed)

### 0.1 Minimize Bug Fix ✅

**Issue**: When the toolbar and property panel are minimized, only the background disappears while the inner content remains visible

**Root Cause**: CSS `display: flex/inline-flex` overrides the default `display: none` of the `[hidden]` attribute

**Solution**:

- [x] Add a global `[hidden] { display: none !important; }` rule at the end of `shadow-host.ts`

### 0.2 Input Field Optimization ✅

**Issues**:

1. Input fields display placeholder instead of actual values
2. Number type inputs don't support keyboard up/down arrow adjustment

**Solution**:

- [x] Create `ui/property-panel/controls/number-stepping.ts` utility module
  - Support ArrowUp/ArrowDown keyboard stepping
  - Support Shift (10x), Alt (0.1x) modifier keys
  - Support multiple CSS units (px, %, rem, em, vh, vw, vmin, vmax)
- [x] Modify all controls to display actual values (inline priority, fallback to computed)
- [x] Add keyboard stepping support for all numeric input fields:
  - `size-control.ts` - Width/Height
  - `spacing-control.ts` - Margin/Padding
  - `position-control.ts` - Top/Right/Bottom/Left/Z-Index
  - `layout-control.ts` - Gap
  - `typography-control.ts` - Font Size/Line Height
  - `appearance-control.ts` - Opacity/Border Radius/Border Width

---

## Phase 1: Base Visual System Alignment ✅ Completed

### 1.1 Color Scheme Refactoring ✅

**Goal**: Adjust the color system from current gray tones to the design mockup's white background + gray input field style

| Property         | Old Value         | New Value                             | Status |
| ---------------- | ----------------- | ------------------------------------- | ------ |
| Panel Background | `#f8f8f8`         | `#ffffff`                             | ✅     |
| Input Background | `#f0f0f0`         | `#f3f3f3`                             | ✅     |
| Input Hover      | `#e8e8e8` (bg)    | `border #e0e0e0` (inset)              | ✅     |
| Input Focus      | `box-shadow` ring | `inset 2px border #3b82f6` + white bg | ✅     |
| Border Color     | `#e8e8e8`         | `#e5e5e5`                             | ✅     |

**Completed Tasks**:

- [x] Update CSS variable definitions (`shadow-host.ts:56-97`)
- [x] Change input hover/focus styles to inset border mode
- [x] Change panel background to pure white

### 1.2 Font & Size Adjustments ✅

| Property        | Old Value   | New Value                    | Status |
| --------------- | ----------- | ---------------------------- | ------ |
| Panel Base Size | `13px`      | `11px`                       | ✅     |
| Label Size      | `11px`      | `10px`                       | ✅     |
| Input Size      | `12px`      | `11px`                       | ✅     |
| Font Family     | System Font | Inter + System Font fallback | ✅     |

**Completed Tasks**:

- [x] Add Inter font declaration (with system font fallback)
- [x] Adjust panel, label, and input font sizes
- [x] Remove label uppercase styling

### 1.3 Spacing & Margin Adjustments ✅

| Property       | Old Value   | New Value  | Status |
| -------------- | ----------- | ---------- | ------ |
| Panel Width    | `320px`     | `280px`    | ✅     |
| Header Padding | `10px 14px` | `8px 12px` | ✅     |
| Body Gap       | `10px`      | `12px`     | ✅     |

**Completed Tasks**:

- [x] Adjust padding/gap for `.we-panel`, `.we-prop-body`, `.we-field-group`
- [x] Adjust header padding

### 1.4 Border Radius & Shadows ✅

| Property     | Old Value   | New Value          | Status |
| ------------ | ----------- | ------------------ | ------ |
| Panel Shadow | `0 1px 2px` | Tailwind shadow-xl | ✅     |
| Input Radius | `6px`       | `4px`              | ✅     |
| Tab Shadow   | None        | `shadow-sm`        | ✅     |

**Completed Tasks**:

- [x] Enhance panel shadow effect (dual-layer shadow simulating shadow-xl)
- [x] Adjust input border radius to 4px
- [x] Add shadow to active Tab

### 1.5 Group/Section Style Refactoring ✅

| Property          | Old Style    | New Style     | Status |
| ----------------- | ------------ | ------------- | ------ |
| Group Border      | Card border  | No border     | ✅     |
| Section Separator | None         | Top separator | ✅     |
| Header Style      | Bold + Large | 11px + #333   | ✅     |

**Completed Tasks**:

- [x] Remove `.we-group` border and background
- [x] Add section separators (`border-top`)
- [x] Adjust group header styles

---

## Phase 2: Input Container Component Refactoring ✅ Basics Completed

### 2.1 Establish Input Container System ✅

**Background**: The design mockup's input fields are not standalone inputs but a container system supporting:

- Prefix: labels, icons
- Suffix: units, icons
- Container-driven hover/focus styles

**Current Structure**:

```html
<div class="we-field">
  <span class="we-field-label">Width</span>
  <input class="we-input" />
</div>
```

**Target Structure**:

```html
<div class="we-field">
  <span class="we-field-label">Position</span>
  <div class="we-input-container">
    <!-- New container -->
    <span class="we-input-container__prefix">X</span>
    <!-- Optional prefix -->
    <input class="we-input-container__input" />
    <span class="we-input-container__suffix">px</span>
    <!-- Optional suffix -->
  </div>
</div>
```

**Completed**:

- [x] Define `.we-input-container` styles in `shadow-host.ts`
- [x] Define `.we-input-container__prefix` and `.we-input-container__suffix` styles
- [x] Create `ui/property-panel/components/input-container.ts` component
- [x] Move hover/focus styles to container level (using `:focus-within`)

### 2.2 Update Controls to Use New Container ✅ Completed

**Controls that need updating**:

- [x] `size-control.ts` - Width/Height (2-column layout + W/H prefix + dynamic unit suffix)
- [x] `spacing-control.ts` - Margin/Padding (refactored to 2x2 grid + direction icon + dynamic unit suffix)
- [x] `position-control.ts` - Top/Right/Bottom/Left/Z-Index (T/R/B/L prefix + dynamic unit suffix)
- [x] `layout-control.ts` - Gap (icon prefix + dynamic unit suffix)
- [x] `typography-control.ts` - Font Size/Line Height (dynamic unit suffix, line-height smart display)
- [ ] `appearance-control.ts` - Opacity/Border Radius/Border Width (pending)

**Completed shared modules**:

- [x] Create `css-helpers.ts` shared module (extractUnitSuffix, hasExplicitUnit, normalizeLength)
- [x] All controls use shared helpers, eliminating duplicate code

---

## Phase 3: Section Structure Refactoring (Pending)

### 3.1 Tab Information Architecture Adjustment

**Current**: 4 Tabs (Design/CSS/Props/DOM)
**Design Mockup**: 2 Tabs (Design/CSS)

**Options**:

- **Option A**: Keep 4 Tabs, adjust to overflow menu
- **Option B**: Move Props/DOM to other entry points
- **Option C**: Keep 4 Tabs, adjust styles to fit

**Tasks**:

- [ ] Determine Tab count product decision
- [ ] Implement selected option

---

## Phase 4: Functional Component Implementation (Pending)

### 4.1 Flow Layout Icon Group ✅ Completed

**Design Mockup Location**: `attr-ui.html:133-156`
**Feature**: 4 icon buttons controlling `flex-direction`

```
[→] Row
[↓] Column
[←] Row Reverse
[↑] Column Reverse
```

**Completed**:

- [x] Create `ui/property-panel/components/icon-button-group.ts` generic component
- [x] Add `.we-icon-button-group` styles in `shadow-host.ts`
- [x] Replace Direction select with icon group in `layout-control.ts`
- [x] Add corresponding SVG arrow icons (row/column/row-reverse/column-reverse)

### 4.2 Alignment 3x3 Grid ✅ Completed

**Design Mockup Location**: `attr-ui.html:166-208`
**Feature**: 3x3 grid controlling `justify-content` + `align-items`

```
[↖][↑][↗]
[←][·][→]
[↙][↓][↘]
```

**Completed**:

- [x] Create `ui/property-panel/components/alignment-grid.ts` component
- [x] Add `.we-alignment-grid` styles in `shadow-host.ts`
- [x] Replace Justify/Align select in `layout-control.ts`
- [x] Use `beginMultiStyle` for atomic commit of two properties

### 4.3 Fix Color Picker ✅ Partially Completed

**Current Issues**:

- `showPicker()` has no try/catch, may throw errors
- Alpha channel is discarded
- Token value `var(--xxx)` displays incorrectly

**Completed**:

- [x] Add error handling for `showPicker()` (try/catch + fallback to click)
- [x] Improve `var()` value parsing and display (pass computed value via placeholder)

**Pending**:

- [ ] Support alpha channel (RGBA/HSLA) - requires third-party color picker
- [ ] Consider adopting third-party color picker (e.g., `@simonwep/pickr`)

---

## Phase 5: New Feature Modules (Pending)

### 5.1 Shadow & Blur Controls

**Design Mockup Location**: `attr-ui.html:396-425`
**Features**:

- Enable/disable toggle
- Type selection (Drop shadow/Inner shadow/Layer Blur/Backdrop Blur)
- Visibility control

**CSS Properties**:

- `box-shadow`
- `filter: blur()`
- `backdrop-filter: blur()`

**Tasks**:

- [x] Create `ui/property-panel/controls/effects-control.ts`
- [x] Implement `box-shadow` value parsing and editing
- [x] Implement `filter` value parsing and editing
- [x] Implement `backdrop-filter` value parsing and editing
- [x] Add type switching UI
- [ ] Add enable/disable toggle (optional, for future implementation)

### 5.2 Gradient Editor

**Design Mockup Location**: `attr-ui.html:269-325`
**Features**:

- Linear/Radial gradient types
- Color stops
- Angle control
- Flip button

**CSS Properties**:

- `background-image: linear-gradient(...)`
- `background-image: radial-gradient(...)`

**Tasks**:

- [x] Create `ui/property-panel/controls/gradient-control.ts`
- [x] Implement gradient value parsing (CSS gradient → data structure)
- [x] Implement angle/position input
- [x] Implement editing for 2 color stops
- [x] Integrate into property-panel (as independent Gradient control group)
- [ ] Implement gradient preview slider (optional, for future optimization)
- [ ] Implement color stop add/delete/drag (optional, for future optimization)

### 5.3 Token/Variable Pill Display

**Design Mockup Location**: `attr-ui.html:374-384`
**Feature**: When value is a CSS variable, display as a clickable pill

**Tasks**:

- [ ] Detect `var(--xxx)` values
- [ ] Render as pill style
- [ ] Click to open token picker

---

## Phase 6: Code Quality (Ongoing)

### 6.1 Style System Unification

- [x] All colors use CSS variables (Phase 1 completed)
- [ ] All sizes use consistent tokens
- [ ] Remove inline styles, consolidate into `shadow-host.ts`

### 6.2 Component Reuse

- [ ] Extract common components to `ui/property-panel/components/`
- [ ] Unify event handling patterns
- [ ] Unify disabled/enabled state handling

### 6.3 Type Safety

- [ ] All components use TypeScript strict types
- [ ] Define clear interfaces and types
- [ ] Remove any type assertions

---

## Implementation Progress

| Phase | Task                     | Status     | Notes                                               |
| ----- | ------------------------ | ---------- | --------------------------------------------------- |
| 0.1   | Minimize Bug Fix         | ✅         | Added global `[hidden]` rule                        |
| 0.2   | Input Field Optimization | ✅         | number-stepping + real value display                |
| 1.1   | Color Scheme Refactor    | ✅         | White bg + gray inputs + inset focus                |
| 1.2   | Font & Size Adjustment   | ✅         | 11px baseline + Inter font                          |
| 1.3   | Spacing & Margin Update  | ✅         | More compact layout                                 |
| 1.4   | Border Radius & Shadows  | ✅         | shadow-xl + 4px radius                              |
| 1.5   | Group/Section Styles     | ✅         | Separator line style                                |
| 2.1   | Input Container System   | ✅         | Component + CSS styles                              |
| 2.2   | Update Controls          | ✅         | All main controls migrated, shared css-helpers.ts   |
| 3.1   | Tab Architecture         | Pending    |                                                     |
| 4.1   | Flow Icon Group          | ✅         | icon-button-group.ts + integrated in layout-control |
| 4.2   | Alignment 3x3 Grid       | ✅         | alignment-grid.ts + integrated in layout-control    |
| 4.3   | Fix Color Picker         | ✅ Partial | showPicker error handling + var() parsing           |
| 5.1   | Shadow & Blur            | ✅         | effects-control.ts + integrated in property-panel   |
| 5.2   | Gradient Editor          | ✅         | gradient-control.ts + integrated in property-panel  |
| 5.3   | Token Pill               | Pending    |                                                     |

---

## Notes

1. **Incremental Implementation**: Each phase should be independently testable and releasable after completion
2. **Maintain Backward Compatibility**: Refactoring should not break existing functionality
3. **Record Design Decisions**: Document reasoning when design mockup conflicts with actual requirements
4. **Performance Considerations**: New components should consider rendering performance, avoiding unnecessary DOM operations
