# Install dependencies
install:
    cd packages/cli && bun install

# Lint with oxlint
lint:
    cd packages/cli && bun run lint

# Format with oxfmt
fmt:
    cd packages/cli && bun run fmt

# Type-check with tsc
check:
    cd packages/cli && bun run check

# Publish both npm packages
publish:
    cd packages/cli && bun publish --access public
    cd packages/botbox && bun publish

link:
    cd packages/cli && bun link
