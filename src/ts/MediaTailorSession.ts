import {
    BitmovinMediaTailorPlayerPolicy,
    companionAdMetric,
    IAdAvail,
    IAdBreakTrackingEvent,
    IAdIcon,
    IAdVerification,
    IMediaFileItem,
    IMediaTailorCompanionAd,
    IMediaTailorSessionTrackingResponse,
    IMtAd,
    interactiveAdMetric,
    isLinearAdMetric,
    isLinearClickMetric,
    isPlayerOperationMetric,
    ITrackingEvent,
    LinearAdClickMetric,
    LinearAdMetric,
    nonLinearAdMetric,
    PlayerOperationMetric
} from "./MediaTailorTypes";
import {
    AdClickedEvent,
    AdEvent,
    ErrorEvent,
    PlaybackEvent,
    PlayerAPI,
    PlayerEvent,
    PlayerResizedEvent,
    TimeChangedEvent,
    TimeMode,
    UserInteractionEvent,
    ViewMode,
    ViewModeChangedEvent
} from "bitmovin-player";
import axios from "axios";
import {Logger} from "./Logger";
import {ArrayUtils} from "bitmovin-player-ui";

export class MediaTailorSession {
    private _trackingResponse!: MediaTailorSessionTrackingResponse;
    private player: PlayerAPI;
    private _playerHeight: number | undefined = undefined;
    private _playerWidth: number | undefined = undefined;
    private _policy: BitmovinMediaTailorPlayerPolicy;

    private _totalDurationAllAvails: number | undefined = undefined;
    private _totalStitchedDuration: number | undefined = undefined;
    private _totalDurationMinusAds: number | undefined = undefined;
    private _activeAdBreak: AdAvail | null = null;
    private _activeAd: MtAd | null = null;

    private isPaused = false;
    private listeners: { [eventType: string]: BMTListenerCallbackFunction[] } = {};

    public static currentSession: MediaTailorSession | undefined = undefined;

    constructor(responseData: unknown, player: PlayerAPI, policy: BitmovinMediaTailorPlayerPolicy) {
        const sessionTrackingResponse = responseData as IMediaTailorSessionTrackingResponse;
        this.trackingResponse = new MediaTailorSessionTrackingResponse(sessionTrackingResponse);
        this.trackingResponse.avails.sort((a, b) => a.startTimeInSeconds - b.startTimeInSeconds);
        this.player = player;
        this._policy = policy;
        player.on(PlayerEvent.TimeChanged, this.onTimeChanged);
        player.on(PlayerEvent.Paused, this.onPaused);
        player.on(PlayerEvent.Play, this.onPlay);
        player.on(PlayerEvent.Muted, this.onMuted);
        player.on(PlayerEvent.Unmuted, this.onUnMuted);
        player.on(PlayerEvent.PlayerResized, this.onPlayerResize);
        player.on(PlayerEvent.ViewModeChanged, this.onViewModeChanged);
        player.on(PlayerEvent.AdSkipped, this.onAdSkipped);
        player.on(PlayerEvent.AdClicked, this.onAdClicked);
        player.on(PlayerEvent.Error, this.onError);
        player.on(PlayerEvent.AdError, this.onError);
        MediaTailorSession.currentSession = this;
    }

    public liveUpdateTracking(responseData: unknown): void {
        const updatedResponse = responseData as IMediaTailorSessionTrackingResponse;
        if (!updatedResponse) return;

        const updated = new MediaTailorSessionTrackingResponse(updatedResponse);
        if (updated.nextToken) this.trackingResponse.nextToken = updated.nextToken;

        updated.avails.forEach(newAvail => {
            const idx = this.trackingResponse.avails.findIndex(
                avail => avail.startTimeInSeconds === newAvail.startTimeInSeconds,
            );
            if (idx === -1) {
                // New ad break — add and re-sort
                this.trackingResponse.avails.push(newAvail);
                this.trackingResponse.avails.sort((a, b) => a.startTimeInSeconds - b.startTimeInSeconds);
            } else {
                // MediaTailor sometimes delivers incomplete tracking events on the first response
                // for a newly started avail in a linear stream. Merge the update into the existing
                // break rather than replacing it wholesale so that already-fired flags are preserved.
                const existing = this.trackingResponse.avails[idx];
                if (existing && existing !== newAvail) {
                    // Replace unfired tracking events with the updated set while keeping fired state
                    newAvail.ads.forEach((newAd, adIdx) => {
                        const existingAd = existing.ads[adIdx];
                        if (existingAd) {
                            newAd.trackingEvents.forEach(newEvent => {
                                const alreadyPresent = existingAd.trackingEvents.some(
                                    e => e.eventId === newEvent.eventId && e.startTimeInSeconds === newEvent.startTimeInSeconds,
                                );
                                if (!alreadyPresent) existingAd.trackingEvents.push(newEvent);
                            });
                        }
                    });
                }
            }
        });
    }

    public shutdown(): void {
        this.player.off(PlayerEvent.TimeChanged, this.onTimeChanged);
        this.player.off(PlayerEvent.Paused, this.onPaused);
        this.player.off(PlayerEvent.Play, this.onPlay);
        this.player.off(PlayerEvent.Muted, this.onMuted);
        this.player.off(PlayerEvent.Unmuted, this.onUnMuted);
        this.player.off(PlayerEvent.PlayerResized, this.onPlayerResize);
        this.player.off(PlayerEvent.ViewModeChanged, this.onViewModeChanged);
        this.player.off(PlayerEvent.AdSkipped, this.onAdSkipped);
        this.player.off(PlayerEvent.AdClicked, this.onAdClicked);
        this.player.off(PlayerEvent.Error, this.onError);
        this.player.off(PlayerEvent.AdError, this.onError);

        this.trackingResponse.shutdown();
        this._activeAd = null;
        this._activeAdBreak = null;
        this._totalDurationAllAvails = undefined;
        this._totalStitchedDuration = undefined;
        this._totalDurationMinusAds = undefined;
        this._policy = undefined!;
        this.listeners = {};
        MediaTailorSession.currentSession = undefined;
    }

    addListener(event: BMTListenerEvent, callback: BMTListenerCallbackFunction): void {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }

    removeListener(event: BMTListenerEvent, callback: BMTListenerCallbackFunction): void {
        ArrayUtils.remove((this.listeners)[event], callback);
    }

    get trackingResponse(): MediaTailorSessionTrackingResponse {
        return this._trackingResponse;
    }

    set trackingResponse(value: MediaTailorSessionTrackingResponse) {
        this._trackingResponse = value;
    }

    // ─── Core time-changed state machine ────────────────────────────────────────

    onTimeChanged = (event: TimeChangedEvent): void => {
        const time = this.player.isLive()
            ? this.player.getCurrentTime(TimeMode.RelativeTime)
            : event.time;
        this.updateActiveAdBreak(time);
        this.updateActiveAd(time);
        this._activeAd?.fireLinearEventBeaconsByTime(time);
    };

    /**
     * Advances the active ad-break state machine for the given playhead position.
     *
     * Fast path: if we're still inside the current break we return immediately.
     * Otherwise we close the current break (if open) and scan for the next one.
     * Already-watched breaks are skipped automatically when the policy requests it.
     */
    private updateActiveAdBreak(time: number): void {
        if (this._activeAdBreak) {
            const breakEnd = this._activeAdBreak.startTimeInSeconds + this._activeAdBreak.durationInSeconds;
            if (time < breakEnd) return; // still inside the current break

            // Current break has ended
            if (!this._activeAdBreak.adBreakEndEventFired) {
                this._activeAdBreak.adBreakEndEventFired = true;
                this.fireAdBreakFinished(this._activeAdBreak);
                this._activeAdBreak.fireAdBreakEvent('breakEnd');
            }
            this._activeAdBreak = null;
        }

        const candidate = this.trackingResponse.avails.find(
            avail =>
                time >= avail.startTimeInSeconds &&
                time < avail.startTimeInSeconds + avail.durationInSeconds,
        );
        if (!candidate) return;

        // Skip over a break the viewer has already watched, if policy allows
        if (candidate.adBreakEndEventFired && this._policy.shouldAutomaticallySkipOverWatchedAdBreaks) {
            this.player.seek(candidate.startTimeInSeconds + candidate.durationInSeconds);
            return;
        }

        this._activeAdBreak = candidate;
        if (!candidate.adBreakStartEventFired) {
            candidate.adBreakStartEventFired = true;
            this.fireAdBreakStart(candidate);
            candidate.fireAdBreakEvent('breakStart');
        }
    }

    /**
     * Advances the active-ad state machine for the given playhead position.
     *
     * Fast path: if we're still inside the current ad we return immediately.
     * Otherwise we close the current ad (if open) and look for the next one
     * within the active ad break.
     */
    private updateActiveAd(time: number): void {
        if (this._activeAd) {
            const adEnd = this._activeAd.startTimeInSeconds + this._activeAd.durationInSeconds;
            if (time < adEnd) return; // still inside the current ad

            if (!this._activeAd.adEndEventFired) {
                this._activeAd.adEndEventFired = true;
                this.fireAdFinished(this._activeAd);
            }
            this._activeAd = null;
        }

        if (!this._activeAdBreak) return;

        const candidate = this._activeAdBreak.ads.find(
            ad =>
                time >= ad.startTimeInSeconds &&
                time < ad.startTimeInSeconds + ad.durationInSeconds &&
                !ad.adEndEventFired,
        );
        if (!candidate) return;

        this._activeAd = candidate;
        if (!candidate.adStartEventFired) {
            candidate.adStartEventFired = true;
            this.fireAdStart(candidate);
        }
    }

    // ─── Event emission helpers ──────────────────────────────────────────────────

    private fireAdStart(ad: MtAd): void {
        this.emitEvent({ type: BMTListenerEvent.ADVERT_START, ad } as BMTAdEvent);
    }

    private fireAdBreakStart(adBreak: AdAvail): void {
        this.emitEvent({ type: BMTListenerEvent.AD_BREAK_START, adBreak } as BMTAdBreakEvent);
    }

    private fireAdBreakFinished(adBreak: AdAvail): void {
        this.emitEvent({ type: BMTListenerEvent.AD_BREAK_END, adBreak } as BMTAdBreakEvent);
    }

    private fireAdFinished(ad: MtAd): void {
        this.emitEvent({ type: BMTListenerEvent.ADVERT_END, ad } as BMTAdEvent);
    }

    // ─── Player event handlers ───────────────────────────────────────────────────

    onAdClicked = (_event: AdClickedEvent): void => {
        // SSAI click events are not surfaced by the Bitmovin player for stitched ads
        Logger.log('AdClicked (SSAI — no-op)');
    };

    onPaused = (_event: PlaybackEvent): void => {
        this.isPaused = true;
        this.getActiveAd()?.firePlayerOperationEventBeacon('pause');
    };

    onPlay = (_event: PlaybackEvent): void => {
        if (this.isPaused) this.getActiveAd()?.firePlayerOperationEventBeacon('resume');
        this.isPaused = false;
    };

    onMuted = (_event: UserInteractionEvent): void => {
        this.getActiveAd()?.firePlayerOperationEventBeacon('mute');
    };

    onUnMuted = (_event: UserInteractionEvent): void => {
        this.getActiveAd()?.firePlayerOperationEventBeacon('unmute');
    };

    onAdSkipped = (_event: AdEvent): void => {
        this.getActiveAd()?.firePlayerOperationEventBeacon('skip');
    };

    onError = (_event: ErrorEvent): void => {
        this.getActiveAdBreak()?.fireAdBreakEvent('error');
        this.getActiveAd()?.firePlayerOperationEventBeacon('error');
    };

    onPlayerResize = (event: PlayerResizedEvent): void => {
        const newWidth = parseInt(event.width);
        const newHeight = parseInt(event.height);

        if (this._playerHeight !== undefined && this._playerWidth !== undefined) {
            if (newHeight < this._playerHeight || newWidth < this._playerWidth) {
                this.getActiveAd()?.firePlayerOperationEventBeacon('playerCollapse');
            } else if (newHeight > this._playerHeight || newWidth > this._playerWidth) {
                this.getActiveAd()?.firePlayerOperationEventBeacon('playerExpand');
            }
        }
        this._playerWidth = newWidth;
        this._playerHeight = newHeight;
    };

    onViewModeChanged = (event: ViewModeChangedEvent): void => {
        if (event.to === ViewMode.Fullscreen) {
            this.getActiveAd()?.firePlayerOperationEventBeacon('playerExpand');
        } else if (
            event.from === ViewMode.Fullscreen &&
            (event.to === ViewMode.Inline || event.to === ViewMode.PictureInPicture)
        ) {
            this.getActiveAd()?.firePlayerOperationEventBeacon('playerCollapse');
        }
    };

    // ─── Duration helpers ────────────────────────────────────────────────────────

    public getTotalDurationOfAdAvails(): number {
        if (this._totalDurationAllAvails !== undefined) return this._totalDurationAllAvails;
        this._totalDurationAllAvails = this.trackingResponse.avails.reduce(
            (sum, avail) => sum + avail.durationInSeconds,
            0,
        );
        return this._totalDurationAllAvails;
    }

    public getContentDurationMinusAds(): number {
        if (this._totalDurationMinusAds !== undefined) return this._totalDurationMinusAds;
        this._totalDurationMinusAds = this.getStitchedContentDuration() - this.getTotalDurationOfAdAvails();
        return this._totalDurationMinusAds;
    }

    public getStitchedContentDuration(): number {
        if (this._totalStitchedDuration !== undefined) return this._totalStitchedDuration;
        this._totalStitchedDuration = this.player.getDuration();
        return this._totalStitchedDuration;
    }

    // ─── Time-conversion helpers ─────────────────────────────────────────────────

    /**
     * Converts a content-only seek target (no ads) into the absolute stitched
     * playhead time, accounting for all ad breaks that precede it.
     */
    public getPlayheadForContentPosition(seekTarget: number, issuer: string | null = null): number {
        void issuer;
        let adBreakTime = 0;
        for (const avail of this.trackingResponse.avails) {
            const adjustedTarget = seekTarget + adBreakTime;
            if (avail.startTimeInSeconds <= adjustedTarget) {
                adBreakTime += avail.durationInSeconds;
            }
        }
        return seekTarget + adBreakTime + 0.001;
    }

    /**
     * Converts an absolute stitched playhead position into the equivalent
     * content-only time, subtracting all ad break durations seen so far.
     */
    public getContentPositionForPlayhead(seekTarget?: number, issuer: string | null = null): number {
        void issuer;
        const timeToUse = seekTarget !== undefined && seekTarget !== null
            ? seekTarget
            : this.player.getCurrentTime();

        let contentTime = timeToUse;
        for (const avail of this.trackingResponse.avails) {
            const breakEnd = avail.startTimeInSeconds + avail.durationInSeconds;
            if (breakEnd <= timeToUse) {
                // Break is fully behind the playhead
                contentTime -= avail.durationInSeconds;
            } else if (avail.startTimeInSeconds <= timeToUse && breakEnd > timeToUse) {
                // Playhead is inside this break — clamp to the break start
                contentTime -= timeToUse - avail.startTimeInSeconds;
            }
        }
        return Math.max(0, contentTime);
    }

    // ─── Public state accessors ──────────────────────────────────────────────────

    public isAdBreakActive(): boolean {
        return this._activeAd !== null;
    }

    public getActiveAd(): MtAd | null {
        return this._activeAd;
    }

    public getActiveAdBreak(): AdAvail | null {
        return this._activeAdBreak;
    }

    public getAllAdBreaks(): AdAvail[] {
        return this._trackingResponse.avails;
    }

    public onAdManifestLoaded = (): void => {
        this.emitEvent({ type: BMTListenerEvent.AD_MANIFEST_LOADED, adBreak: null } as BMTAdBreakEvent);
    };

    public onTrackingEvent(type: string): void {
        Logger.log('[listener] AnalyticsFired', type);
        const event: BMTAnalyticsFiredEvent = {
            type: BMTListenerEvent.ANALYTICS_FIRED,
            call_id: type,
        };
        this.emitEvent(event);
    }

    private emitEvent(event: BMTListenerEventBase): void {
        const handlers = this.listeners[event.type];
        if (handlers) {
            for (const callback of handlers) {
                callback(event);
            }
        }
    }
}


export interface BMTAnalyticsFiredEvent extends BMTListenerEventBase {
    call_id: string;
}

export interface BMTAdBreakEvent extends BMTListenerEventBase {
    adBreak: AdAvail | null;
}

export interface BMTAdEvent extends BMTListenerEventBase {
    ad: MtAd;
}
// Internal event-bus callbacks are typed loosely so callers can register
// strongly-typed handlers (BMTAdEvent, BMTAdBreakEvent, …) without running
// into strict contravariance errors.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BMTListenerCallbackFunction = (event: any) => void;

interface BMTListenerEventBase {
    type: BMTListenerEvent;
}

export enum BMTListenerEvent {
    AD_BREAK_START = 'AdBreakStarted',
    ADVERT_START = 'AdStarted',
    ADVERT_END = 'AdEnded',
    AD_BREAK_END = 'AdBreakEnded',
    ANALYTICS_FIRED = 'AnalyticsFired',
    AD_MANIFEST_LOADED = 'AdManifestLoaded'
}

class AdBreakTrackingEvent implements IAdBreakTrackingEvent {
    beaconUrls: string[] | null;
    eventType: 'breakStart' | 'breakEnd' | 'error';
    trackingEventFired: boolean;
    trackingEventFireSuccess: boolean | undefined;

    constructor(event: IAdBreakTrackingEvent) {
        this.beaconUrls = event.beaconUrls ?? null;
        this.eventType = event.eventType;
        this.trackingEventFired = false;
        this.trackingEventFireSuccess = undefined;
    }

    public fireAdBreakTrackingEvent(): void {
        if (!this.beaconUrls) return;
        this.trackingEventFired = true;
        for (const url of this.beaconUrls) {
            axios.get(url)
                .then(() => {
                    this.trackingEventFireSuccess = true;
                    Logger.log(`Fired breakEvent '${this.eventType}' → ${url}`);
                })
                .catch(err => {
                    this.trackingEventFireSuccess = false;
                    Logger.error(`Failed to fire breakEvent '${this.eventType}' → ${url}: ${err.message}`);
                })
                .finally(() => {
                    MediaTailorSession.currentSession?.onTrackingEvent(this.eventType);
                });
        }
    }
}

export class TrackingEvent implements ITrackingEvent {
    beaconUrls: string[] | null;
    duration: string | null;
    durationInSeconds: number | null;
    eventId: string | null;
    eventProgramDateTime: string | null;
    eventType: PlayerOperationMetric | LinearAdMetric | LinearAdClickMetric | nonLinearAdMetric | companionAdMetric | interactiveAdMetric;
    offset: string | null;
    startTime: string | null;
    startTimeInSeconds: number | null;
    trackingEventFired: boolean;
    trackingEventFireSuccess: boolean | undefined;

    constructor(event: ITrackingEvent) {
        this.beaconUrls = event.beaconUrls ?? null;
        this.eventType = event.eventType;
        this.duration = event.duration ?? null;
        this.durationInSeconds = event.durationInSeconds ?? null;
        this.eventId = event.eventId ?? null;
        this.eventProgramDateTime = event.eventProgramDateTime ?? null;
        this.offset = event.offset ?? null;
        this.startTime = event.startTime ?? null;
        this.startTimeInSeconds = event.startTimeInSeconds ?? null;
        this.trackingEventFired = false;
        this.trackingEventFireSuccess = undefined;
    }

    public fireTrackingEvent(): void {
        if (!this.beaconUrls) return;
        this.trackingEventFired = true;
        for (const url of this.beaconUrls) {
            axios.get(url)
                .then(() => {
                    this.trackingEventFireSuccess = true;
                    Logger.log(`Fired '${this.eventType}' (id=${this.eventId}) → ${url}`);
                })
                .catch(err => {
                    this.trackingEventFireSuccess = false;
                    Logger.error(`Failed to fire '${this.eventType}' (id=${this.eventId}) → ${url}: ${err.message}`);
                })
                .finally(() => {
                    MediaTailorSession.currentSession?.onTrackingEvent(this.eventType);
                });
        }
    }
}

export class MtAd implements IMtAd {
    public readonly adId: string;
    public readonly adParameters: string | null;
    public readonly adProgramDateTime: string | null;
    public readonly adSystem: string;
    public readonly adTitle: string;
    public readonly adVerifications: IAdVerification[];
    public readonly companionAds: IMediaTailorCompanionAd[];
    public readonly creativeId: string | null;
    public readonly creativeSequence: string | null;
    public readonly duration: string;
    public readonly durationInSeconds: number;
    public readonly extensions: { content?: string | null; type?: string | null }[];
    public readonly icons: IAdIcon[];
    public readonly mediaFiles: { mediaFilesList: IMediaFileItem[]; mezzanine: string | null }[];
    public readonly skipOffset: string | null;
    public readonly startTime: string;
    public readonly startTimeInSeconds: number;
    public readonly trackingEvents: TrackingEvent[] = [];
    public readonly vastAdId: string | null;
    public clickThroughUrl: string | null = null;
    adStartEventFired = false;
    adEndEventFired = false;
    public clickThroughUrlOpened?: () => void = undefined;

    constructor(ad: IMtAd) {
        this.adId = ad.adId ?? '';
        this.adParameters = ad.adParameters ?? null;
        this.adProgramDateTime = ad.adProgramDateTime ?? null;
        this.adSystem = ad.adSystem ?? '';
        this.adTitle = ad.adTitle ?? '';
        this.adVerifications = ad.adVerifications ?? [];
        this.companionAds = ad.companionAds ?? [];
        this.creativeId = ad.creativeId ?? null;
        this.creativeSequence = ad.creativeSequence ?? null;
        this.duration = ad.duration;
        this.durationInSeconds = ad.durationInSeconds;
        this.extensions = ad.extensions ?? [];
        this.icons = ad.icons ?? [];
        this.mediaFiles = ad.mediaFiles ?? [];
        this.skipOffset = ad.skipOffset ?? null;
        this.startTime = ad.startTime;
        this.startTimeInSeconds = ad.startTimeInSeconds;
        this.vastAdId = ad.vastAdId ?? null;
        for (const event of ad.trackingEvents) {
            this.trackingEvents.push(new TrackingEvent(event));
        }
        this.findClickThroughs();
    }

    private findClickThroughs(): void {
        const clickThrough = this.trackingEvents.find(e => e.eventType === 'clickThrough');
        if (!clickThrough?.beaconUrls?.length) return;

        this.clickThroughUrl = clickThrough.beaconUrls[0] ?? null;
        if (!this.clickThroughUrl) return;

        this.clickThroughUrlOpened = () => {
            this.fireLinearClickEventBeacon('clickTracking');
        };
    }

    /**
     * Fires any unfired linear metric beacons whose scheduled time falls within
     * a ±0.1 s / +0.3 s window around the current playhead position.
     */
    public fireLinearEventBeaconsByTime(time: number): void {
        const pending = this.trackingEvents.filter(
            e =>
                isLinearAdMetric(e.eventType) &&
                !e.trackingEventFired &&
                e.startTimeInSeconds !== null &&
                time >= e.startTimeInSeconds - 0.1 &&
                time <= e.startTimeInSeconds + 0.3,
        );
        for (const event of pending) {
            if (event.eventType !== 'closeLinear') {
                // TODO: implement closeLinear support
                event.fireTrackingEvent();
            }
        }
    }

    public fireLinearClickEventBeacon(clickMetric: LinearAdClickMetric): void {
        if (clickMetric === 'clickThrough') return;
        const toFire = this.trackingEvents.filter(
            e => isLinearClickMetric(e.eventType) && e.eventType === clickMetric,
        );
        for (const event of toFire) event.fireTrackingEvent();
    }

    public firePlayerOperationEventBeacon(playerOperation: PlayerOperationMetric): void {
        const playerEvents = this.trackingEvents.filter(e => isPlayerOperationMetric(e.eventType));
        if (playerOperation === 'optional' || playerOperation === 'notUsed') return;

        if (playerOperation === 'error') {
            // Replace error-code placeholder before firing
            const errorEvents = playerEvents.filter(e => e.eventType === 'error');
            for (const e of errorEvents) {
                e.beaconUrls = e.beaconUrls?.map(url => url.replace('[ERRORCODE]', '400')) ?? null;
                e.fireTrackingEvent();
            }
            return;
        }

        const toFire = playerEvents.filter(e => e.eventType === playerOperation);
        for (const event of toFire) event.fireTrackingEvent();
    }
}

export class MediaTailorSessionTrackingResponse implements IMediaTailorSessionTrackingResponse {
    avails: AdAvail[] = [];
    dashAvailabilityStartTime?: string | null;
    hlsAnchorMediaSequenceNumber?: string | null;
    nextToken?: string | null;
    nonLinearAvails?: unknown[];

    constructor(response: IMediaTailorSessionTrackingResponse) {
        this.dashAvailabilityStartTime = response.dashAvailabilityStartTime;
        this.hlsAnchorMediaSequenceNumber = response.hlsAnchorMediaSequenceNumber;
        this.nextToken = response.nextToken;
        this.nonLinearAvails = response.nonLinearAvails; // TODO: create interface for nonLinearAvails
        for (const avail of response.avails ?? []) {
            this.avails.push(new AdAvail(avail));
        }
    }

    public shutdown(): void {
        this.avails = [];
    }
}

export class AdAvail implements IAdAvail {
    adBreakTrackingEvents: AdBreakTrackingEvent[] = [];
    adMarkerDuration: unknown;
    ads: MtAd[] = [];
    availId: string;
    availProgramDateTime: string | null;
    duration: string;
    durationInSeconds: number;
    meta: unknown;
    nonLinearAdsList: [];
    startTime: string;
    startTimeInSeconds: number;
    adBreakStartEventFired = false;
    adBreakEndEventFired = false;

    constructor(avail: IAdAvail) {
        this.adMarkerDuration = avail.adMarkerDuration;
        this.availId = avail.availId ?? '';
        this.availProgramDateTime = avail.availProgramDateTime ?? null;
        this.duration = avail.duration;
        this.durationInSeconds = avail.durationInSeconds;
        this.meta = avail.meta;
        this.startTime = avail.startTime;
        this.startTimeInSeconds = avail.startTimeInSeconds;
        this.nonLinearAdsList = avail.nonLinearAdsList; // TODO: create interface for nonLinearAdsList
        for (const event of avail.adBreakTrackingEvents) {
            this.adBreakTrackingEvents.push(new AdBreakTrackingEvent(event));
        }
        for (const ad of avail.ads ?? []) {
            this.ads.push(new MtAd(ad));
        }
    }

    public fireAdBreakEvent(metric: 'breakStart' | 'breakEnd' | 'error'): void {
        const matching = this.adBreakTrackingEvents.filter(e => e.eventType === metric);
        if (metric === 'error') {
            for (const e of matching) {
                e.beaconUrls = e.beaconUrls?.map(url => url.replace('[ERRORCODE]', '400')) ?? null;
                e.fireAdBreakTrackingEvent();
            }
        } else {
            for (const e of matching) e.fireAdBreakTrackingEvent();
        }
    }
}
