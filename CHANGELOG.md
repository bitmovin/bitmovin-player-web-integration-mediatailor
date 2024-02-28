# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/)
and this project adheres to [Semantic Versioning](http://semver.org/).

## 1.0.1 - 2024-02-28

### Added
- Support for MediaTailor HLS Linear streams(Linear Stream Assembly)

### Fixed
- Some AdEvents(impression, start, acceptInvitationLinear) related to the beginning of the first Ad within a new AdBreak starting were not firing

## 1.0.0 - 2024-01-10

### Added

- Initial MediaTailor integration
- TimeMode to `getCurrentTime` method
