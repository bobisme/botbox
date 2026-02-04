# Build (no build step for JS, but run checks)
build:
    just check
    just lint

# Run tests
test:
    cd packages/cli && bun test

# Install globally (link for development)
install:
    cd packages/cli && bun link

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

install:
    cd packages/cli && bun link
