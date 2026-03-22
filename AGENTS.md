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

### Architecture Pattern

```
src/
├── app.ts              # App class - orchestration
├── index.ts            # Entry point
├── store/              # State management (Store class)
├── layout/             # UI Components (render only)
├── controllers/        # Input handling + logic
├── config/             # Configuration I/O
├── constants/          # Constants
├── theme/              # Theming
└── utils/             # Utilities
```

**Component Pattern:**
```typescript
class Sidebar {
  constructor(renderer: CliRenderer, store: Store) { }
  render(): void { /* reads store, builds UI */ }
  update(): void { /* re-renders */ }
}
```

**Store Pattern:**
```typescript
class Store {
  getState(): AppState { }
  setState(partial: Partial<AppState>): void { /* notifies subscribers */ }
  subscribe(listener: (state: AppState) => void): () => void { }
}
```

**Controller Pattern:**
```typescript
class AppController {
  constructor(renderer: CliRenderer, store: Store, sidebar: Sidebar) { }
  start(): void { /* subscribe store, register keyboard handlers */ }
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
- Components build their own renderables, don't modify external state
- Never call `process.exit()` directly - use `renderer.destroy()`

## Testing
- No test framework configured yet
- Manual testing: `bun run dev`, interact with app, verify behavior

## Adding New Components

1. Create component in `layout/` or relevant directory
2. Component receives `renderer` and `store` via constructor
3. Component has `render()` method that reads from store
4. Subscribe to store changes via controller or direct subscription
5. Update components by calling their `update()` or `render()` method

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
