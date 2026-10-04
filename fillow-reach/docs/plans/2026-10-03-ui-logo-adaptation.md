# UI & Logo Adaptation - fillow Reach

## Overview

fillow Reach is a sister project to fillow, focused on recruiter outreach rather than job applications. To maintain visual consistency across the fillow ecosystem, fillow Reach must use the same UI style and logo as the parent fillow project.

## Current Status

### ✅ COMPLETED - Core Functionality
- **Company + person upsert helpers** (`lib/reach/people.mjs`)
- **Connections.csv import** (`lib/reach/import-connections.mjs`) 
- **Acceptance detection + bounce detection** (`lib/reach/acceptance.mjs`)
- **Hunter provider** (`lib/reach/provider-hunter.mjs`)
- **Basic test infrastructure** (`tests/reach-people.test.mjs`)

### 🔄 IN PROGRESS - UI & Logo Adaptation
- **Logo adaptation** - Using fillow's logo design
- **UI component styling** - Adapting to fillow's design system
- **Dashboard structure** - Following fillow's layout patterns
- **Component consistency** - Matching fillow's chip, card, and navigation styles

## Parent Project Reference

### Logo
**Source:** `/media/taksha/New Volume/follow/output/fillow_logo.png`

### UI Design System
Based on `/media/taksha/New Volume/follow/output/dashboard.html`

**Color Palette:**
```css
--bg: #100f0c
--panel: #181612
--ink: #f4efe6
--mute: #9c9488
--line: #2a261f
--gold: #e0a14a
--moss: #7dba7a
--rose: #d46a5c
```

**Typography:**
- **Headings:** Fraunces (italic, serif)
- **Body:** IBM Plex Sans (400, 500, 600 weight)

**Layout:**
- Grid-based system
- Consistent spacing and alignment
- Professional, clean aesthetic

## Adaptation Requirements

### 1. Logo Integration
- Use fillow's logo design (fillow_logo.png)
- Maintain consistent sizing and positioning
- Adapt logo usage for reach-specific context

### 2. UI Component Styling
- **Cards & Panels:** Match fillow's panel styling with `--panel` background
- **Navigation:** Use fillow's `.pipe` navigation pattern
- **Buttons & Chips:** Adapt fillow's chip components
- **Forms:** Match fillow's input styling
- **Tables:** Follow fillow's list/row grid system

### 3. Dashboard Structure
- **Layout:** Use fillow's wrap-container approach
- **Navigation:** Implement fillow's .pipe navigation system
- **Data display:** Follow fillow's job/filing row patterns
- **Status indicators:** Use fillow's gold/moss/rose color coding

### 4. Typography & Spacing
- **Headings:** Apply Fraunces font family
- **Body text:** Use IBM Plex Sans with proper line height
- **Spacing:** Follow fillow's consistent margin/padding patterns
- **Alignment:** Match fillow's grid-based alignment

## Files to Update

### Core UI Files
1. **`fillow-reach/fillow_logo.png`** - Logo adaptation
2. **Dashboard UI components** - Styling and layout
3. **Reach-specific components** - Adapted from fillow patterns
4. **Theme variables** - Fillow's CSS variables for consistency

### Documentation
1. **UI adaptation guide** - Design system documentation
2. **Styling specifications** - Component styling guidelines
3. **Logo usage guidelines** - Brand identity rules

## Next Steps

1. **Immediate:** Complete logo implementation
2. **Short-term:** Adapt core UI components
3. **Medium-term:** Update dashboard structure
4. **Long-term:** Full UI consistency with fillow

## Testing

All UI changes should be tested against:
- fillow's dashboard.html visual reference
- Component consistency checks
- Cross-platform compatibility
- Accessibility standards

## Review Checklist

- [ ] Logo implementation matches parent project
- [ ] Color scheme aligned with fillow's variables
- [ ] Typography matches fillow's font hierarchy
- [ ] Component styling consistent with fillow patterns
- [ ] Navigation system follows fillow's approach
- [ ] Dashboard layout matches fillow structure
- [ ] All tests pass with new UI implementation

## Notes

- fillow Reach maintains its unique functionality while adopting fillow's visual language
- The goal is visual consistency without compromising reach-specific features
- Gradual adaptation ensures maintainability and test coverage
- Reference fillow's design system for all UI decisions