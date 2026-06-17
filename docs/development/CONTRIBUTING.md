# Contributing to BetterDesk Console

Thank you for your interest in contributing to BetterDesk Console! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)

## Code of Conduct

This project adheres to a code of conduct that all contributors are expected to follow:

- Be respectful and inclusive
- Be patient with newcomers
- Focus on what is best for the community
- Show empathy towards other community members

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally
3. Create a branch for your changes
4. Make your changes
5. Test your changes thoroughly
6. Submit a pull request

## How to Contribute

### Types of Contributions

- **Bug Fixes**: Fix issues in existing code
- **New Features**: Add new functionality
- **Documentation**: Improve or add documentation
- **Tests**: Add or improve test coverage
- **UI/UX**: Improve user interface or experience
- **Performance**: Optimize code performance
- **Security**: Fix security vulnerabilities

### Areas Needing Help

- Multi-language support (i18n)
- Authentication system
- Mobile responsiveness improvements
- API documentation
- Test coverage
- Performance optimization

## Development Setup

### Prerequisites

- Linux environment (Ubuntu 20.04+ recommended)
- Python 3.8+
- Rust 1.70+
- Git
- RustDesk HBBS installed

### Local Setup

```bash
# Clone your fork
git clone https://github.com/UNITRONIX/Rustdesk-FreeConsole.git
cd Rustdesk-FreeConsole

# Install Python dependencies
cd web
pip3 install -r requirements.txt

# Run demo app for testing
python3 app_demo.py
```

### Testing HBBS Changes

```bash
# Navigate to hbbs-patch
cd hbbs-patch

# Clone RustDesk server (if not already done)
git clone https://github.com/rustdesk/rustdesk-server.git temp-rustdesk
cd temp-rustdesk

# Copy patched files
cp ../src/* src/

# Build and test
cargo build --release --bin hbbs
./target/release/hbbs --help
```

## Coding Standards

### Python (Flask)

- Follow PEP 8 style guide
- Use type hints where possible
- Write docstrings for functions and classes
- Maximum line length: 100 characters
- Use meaningful variable names

Example:
```python
def get_device_status(device_id: str) -> dict:
    """
    Get the current status of a device.
    
    Args:
        device_id: The unique identifier of the device
        
    Returns:
        Dictionary containing device status information
    """
    # Implementation
```

### Rust (HBBS Patches)

- Follow Rust standard style (rustfmt)
- Use meaningful variable names
- Add comments for complex logic
- Prefer immutable references
- Use proper error handling (Result/Option)

Example:
```rust
/// Fetches online peers from the shared PeerMap
async fn get_online_peers(state: &ApiState) -> Vec<PeerStatus> {
    // Implementation
}
```

### JavaScript

- Use ES6+ features
- Use const/let, avoid var
- Prefer arrow functions
- Use async/await for promises
- Maximum line length: 100 characters

Example:
```javascript
async function fetchDevices() {
    try {
        const response = await fetch('/api/devices');
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Failed to fetch devices:', error);
    }
}
```

### CSS

- Use meaningful class names (BEM methodology)
- Group related properties
- Use CSS variables for colors
- Mobile-first approach
- Comment complex selectors

Example:
```css
/* Device status badge component */
.status-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.status-badge--active {
    color: var(--success-color);
}
```

## Commit Messages

Follow the Conventional Commits specification:

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation changes
- **style**: Code style changes (formatting, no logic change)
- **refactor**: Code refactoring
- **perf**: Performance improvements
- **test**: Adding or updating tests
- **chore**: Maintenance tasks

### Examples

```
feat(api): add device grouping endpoint

Implement REST API endpoint for grouping devices by custom tags.
Includes database migration and unit tests.

Closes #123
```

```
fix(ui): correct status badge color on dark theme

The status badge was using incorrect color variable in dark mode,
making it hard to read. Updated to use theme-aware color.

Fixes #456
```

## Pull Request Process

### Before Submitting

1. ✅ Update documentation if needed
2. ✅ Add tests for new features
3. ✅ Run all tests locally
4. ✅ Update CHANGELOG.md
5. ✅ Ensure code follows style guidelines
6. ✅ Rebase on latest main branch

### PR Description Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
How was this tested?

## Screenshots (if applicable)
Add screenshots for UI changes

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
- [ ] Tests added/updated
- [ ] No new warnings
- [ ] CHANGELOG.md updated
```

### Review Process

1. Automated checks must pass (if configured)
2. At least one maintainer approval required
3. All review comments addressed
4. Squash commits if requested
5. Maintainer will merge when ready

## Reporting Bugs

### Before Reporting

- Search existing issues
- Check if it's already fixed in main branch
- Verify it's reproducible

### Bug Report Template

```markdown
**Description**
Clear description of the bug

**Steps to Reproduce**
1. Go to '...'
2. Click on '...'
3. See error

**Expected Behavior**
What should happen

**Actual Behavior**
What actually happens

**Environment**
- OS: [e.g., Ubuntu 22.04]
- RustDesk Version: [e.g., 1.1.9]
- BetterDesk Console Version: [e.g., 1.0.0]
- Browser: [e.g., Chrome 120]

**Logs**
```
Paste relevant logs here
```

**Screenshots**
Add screenshots if applicable
```

## Suggesting Features

### Feature Request Template

```markdown
**Is your feature related to a problem?**
Clear description of the problem

**Describe the solution**
What would you like to see implemented?

**Describe alternatives**
Other solutions you've considered

**Additional context**
Any other information, mockups, examples
```

## Questions?

- Open a GitHub Discussion
- Check existing documentation
- Ask in pull request comments

## License

By contributing, you agree that your contributions will be licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

---

Thank you for contributing to BetterDesk Console! 🎉
