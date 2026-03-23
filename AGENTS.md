# Agent Guidelines for torrent-tui

## Build Commands

```bash
# Run the app
bun run src/index.ts

# Development mode (watch)
bun run dev

# Format and fix lint issues
bun run check:fix
```

## Project Overview

- **Runtime**: Bun
- **UI Framework**: @opentui/core (Core API, not React/Solid)
- **Validation**: Zod
- **Language**: TypeScript (strict mode)

## Code Style

### Formatting
- Uses **Biome** for linting and formatting
- Indentation: **Tabs**
- Quote style: **Double quotes**
- Run `bun run check:fix` before committing

### TypeScript
- **Strict mode** enabled
- No implicit `any` (warns)
- No non-null assertions without reason (warns)
- Use explicit types for function parameters
- Prefer interfaces for object shapes

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Classes | PascalCase | `class App`, `class Store` |
| Methods | camelCase | `getState()`, `handleKeyPress()` |
| Variables | camelCase | `selectedIndex`, `isActive` |
| Constants | camelCase | `INITIAL_STATE`, `APP_NAME` |
| Files | kebab-case | `app-controller.ts`, `sidebar.ts` |
| Directories | kebab-case | `layout/`, `controllers/` |

### Imports
- Use relative imports (`./store`, `../constants`)
- Group imports: external → internal → types
- No barrel exports unless necessary

## Architecture

```
src/
├── app.ts                    # App class - orchestration
├── index.ts                  # Entry point
├── store/                    # State management (Store class)
├── layout/                   # UI Components
│   ├── sidebar.ts            # Sidebar with navigation items
│   └── content-window.ts     # Main content area
├── controllers/             # Input handling + logic
│   └── app-controller.ts     # Keyboard input handling
├── config/                   # Configuration I/O
├── constants/                # App constants
├── theme/                    # Theming
├── types/                    # TypeScript interfaces
│   └── layout.ts            # LayoutDimensions interface
└── utils/                    # Utilities
    └── layout.ts            # calculateLayout()
```

### Layout System

Components use absolute positioning (not flexbox) for side-by-side placement:

```typescript
// src/types/layout.ts
interface LayoutDimensions {
	terminal: { width: number; height: number };
	sidebar: { x: number; y: number; width: number; height: number };
	content: { x: number; y: number; width: number; height: number };
}

// src/utils/layout.ts
function calculateLayout(terminalWidth: number, terminalHeight: number): LayoutDimensions
```

### Component Pattern

Components render once with absolute positioning, update in-place:

```typescript
class Sidebar {
	private container: BoxRenderable;
	private itemTexts: SidebarItem[] = [];

	constructor(renderer: CliRenderer, store: Store, layout: LayoutDimensions) {
		this.container = this.build();  // Creates all elements
		this.renderer.root.add(this.container);
	}

	update(): void {
		// Updates text content in-place, no destroy/recreate
		for (const item of this.itemTexts) {
			(item.text as unknown as { content: string }).content = "new content";
		}
	}

	updateLayout(layout: LayoutDimensions): void {
		// Handle terminal resize
	}
}
```

### Store Pattern

```typescript
class Store {
	getState(): AppState { }
	setState(partial: Partial<AppState>): void { /* notifies subscribers */ }
	subscribe(listener: (state: AppState) => void): () => void { }
}
```

### Controller Pattern

```typescript
class AppController {
	constructor(
		renderer: CliRenderer,
		store: Store,
		sidebar: Sidebar,
		contentWindow: ContentWindow,
	) { }

	start(): void {
		this.store.subscribe(() => {
			this.sidebar.update();
			this.contentWindow.update();
		});
		this.renderer.keyInput.on("keypress", (key) => {
			this.handleKeyPress(key);
		});
	}
}
```

### App Orchestration

```typescript
class App {
	private layout!: LayoutDimensions;

	private async initialize(): Promise<void> {
		this.renderer = await createCliRenderer({ exitOnCtrlC: true });
		this.store = new Store(INITIAL_STATE);
		this.layout = calculateLayout(this.renderer.width, this.renderer.height);
	}

	private setupComponents(): void {
		this.sidebar = new Sidebar(this.renderer, this.store, this.layout);
		this.contentWindow = new ContentWindow(this.renderer, this.store, this.layout);
	}
}
```

### Error Handling
- Use try-catch for async operations
- Catch blocks should handle gracefully
- No silent failures without reason
- Prefer specific error types over generic `catch (err)`

### OpenTUI Specific
- Use **construct API** (`Box()`, `Text()`) not JSX
- Pass `renderer` instance to `BoxRenderable`/`TextRenderable` constructors
- Use `position: "absolute"` with `left`, `top` for side-by-side layout
- Components build their own renderables, don't modify external state
- Never call `process.exit()` directly - use `renderer.destroy()`

## Testing
- No test framework configured yet
- Manual testing: `bun run dev`, interact with app, verify behavior

## Adding New Components

1. Create component in `layout/` with kebab-case name (e.g., `new-component.ts`)
2. Component receives `renderer`, `store`, and `layout` via constructor
3. Component builds its UI once in constructor using absolute positioning
4. `update()` method modifies existing elements in-place (don't destroy/recreate)
5. Add `updateLayout()` method for resize handling
6. Subscribe to store changes in controller, call `update()` on changes

## Adding New State

1. Add to `AppState` interface in `store/index.ts`
2. Initialize in `INITIAL_STATE` in `app.ts`
3. Components read from `store.getState()`
4. Controllers update via `store.setState({ key: value })`

## Common Tasks

```bash
# Add a new dependency
bun add <package>

# Update dependencies
bun update

# Check types without building
npx tsc --noEmit
```
