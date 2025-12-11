.PHONY: build build-frontend build-backend clean install help

# Default target
all: build

# Build both frontend and backend
build: build-frontend build-backend

# Build frontend
build-frontend:
	@echo "Building frontend..."
	cd frontend/ && pnpm install --frozen-lockfile && pnpm run build && cd ..

# Build backend with optimization flags
# -ldflags="-s -w": Strip symbol table and debug information to reduce binary size
# -trimpath: Remove all file system paths from the resulting executable
build-backend:
	@echo "Building backend..."
	go build -ldflags="-s -w" -trimpath -o filebrowser .

# Install dependencies for frontend
install:
	@echo "Installing frontend dependencies..."
	cd frontend/ && pnpm install --frozen-lockfile && cd ..

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf frontend/dist
	rm -f filebrowser
	@echo "Clean complete."

# Show help information
help:
	@echo "Available targets:"
	@echo "  build          - Build both frontend and backend (default)"
	@echo "  build-frontend - Build frontend only"
	@echo "  build-backend  - Build backend only with optimization flags"
	@echo "  install        - Install frontend dependencies"
	@echo "  clean          - Clean build artifacts"
	@echo "  help           - Show this help message"

