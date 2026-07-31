# LX Bridge

A lightweight plugin for the [Songloft](https://github.com/songloft-org) ecosystem, providing bridge functionality between lxserver and MIoT smart speaker integration.

## Disclaimer

This software is provided for **educational and technical reference purposes only**. 

- The author makes no warranties regarding the legality of using this software in any specific jurisdiction.
- Users are solely responsible for ensuring compliance with all applicable laws, regulations, and third-party terms of service.
- The author does not encourage, endorse, or assume responsibility for any misuse of this software.
- This project does not host, distribute, or facilitate access to any copyrighted content.

By using this software, you acknowledge that you have read this disclaimer and agree to use it responsibly.

## Features

- Smart speaker device integration
- Configurable bridge connectivity
- Web-based management interface
- Setup wizard for quick initialization

## Tech Stack

- TypeScript
- Node.js
- HTML/CSS/JS

## Getting Started

### Prerequisites

- Songloft ≥ 1.3.0
- MIoT Plugin ≥ 2026.6.18
- LXServer ≥ 2.0.0

### Installation

1. Install the plugin from the Songloft plugin marketplace
2. Complete the setup wizard via the web interface

### Development

```bash
npm install
npm run dev
npm run build
```

The release package is `dist/lxbridge.jsplugin.zip`. On Windows, the final auxiliary syntax-check step can report `ENAMETOOLONG`; it is non-blocking when esbuild compilation, ZIP creation, and hash verification succeed.

## License

Apache-2.0
