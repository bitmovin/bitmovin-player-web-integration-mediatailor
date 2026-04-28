# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/)
and this project adheres to [Semantic Versioning](http://semver.org/).

## 1.1.0 - 2026-04-28

### Changed
- Updated Bitmovin Player Web SDK peer dependency to `^8.256.0`
- Updated TypeScript to `^6.0.3` and modernized `tsconfig.json`: `strict` mode enabled, target raised to `es2017`, lib updated to `es2020`
- Updated `@typescript-eslint` to `^8.0.0`, ESLint to `^9.0.0`, webpack-dev-server to `^5`, husky to `^9`
- Node.js engine requirement raised to `>=18.0.0`
- `onTimeChanged` ad-state machine refactored into explicit `updateActiveAdBreak` / `updateActiveAd` methods with clear fast-path early returns; `fireLinearEventBeaconsByTime` is now called exactly once per tick instead of twice
- `shutdown()` now explicitly unregisters all player event listeners, preventing dangling callbacks after unload
- `liveUpdateTracking` now merges new tracking events into existing ad breaks at the correct array index rather than only appending new breaks; already-fired event state is preserved during the merge

### Fixed
- `unregisterPlayerEvents` was calling `player.on` instead of `player.off` for `Muted` and `Unmuted` events, so those listeners were never removed
- `liveUpdateTracking` was reassigning the result of `Array.find` to a local variable (`existingMatchedBreak = newAvail`) which did not update the underlying array — existing ad breaks were never actually refreshed
- `getContentPositionForPlayhead` null-guard used `||` instead of `&&`, causing `seekTarget` to always be preferred even when it was `undefined`
- Removed leftover `console.log('mcarriga …')` debug statements from `MediaTailorSession.ts`, `InternalBitmovinMtPlayer.ts`, and `index.html`

## 1.0.1 - 2024-02-28

### Added
- Support for MediaTailor HLS Linear streams(Linear Stream Assembly)

### Fixed
- Some AdEvents(impression, start, acceptInvitationLinear) related to the beginning of the first Ad within a new AdBreak starting were not firing

## 1.0.0 - 2024-01-10

### Added

- Initial MediaTailor integration
- TimeMode to `getCurrentTime` method
