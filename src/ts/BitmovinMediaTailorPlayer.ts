import {BitmovinMediaTailorAPI} from "./BitmovinMediaTailorAPI";
import {
    BitmovinMediaTailorPlayerPolicy,
    MediaTailorPlayerType,
    MtConfiguration,
    MtSourceConfig
} from "./MediaTailorTypes";
import {
    AdaptationAPI,
    AudioQuality,
    AudioTrack,
    DownloadedAudioData,
    DownloadedVideoData,
    DrmAPI,
    LogLevel,
    LowLatencyAPI,
    MetadataType,
    PlayerAdvertisingAPI,
    PlayerAPI,
    PlayerBufferAPI,
    PlayerConfig,
    PlayerEvent,
    PlayerEventCallback,
    PlayerExports,
    PlayerManifestAPI,
    PlayerSubtitlesAPI,
    PlayerType,
    PlayerVRAPI,
    QueryParameters,
    SegmentMap,
    Snapshot,
    SourceConfig,
    StaticPlayerAPI,
    StreamType,
    SupportedTechnologyMode,
    Technology,
    Thumbnail,
    TimeRange,
    VideoQuality,
    ViewMode,
    ViewModeOptions
} from "bitmovin-player";
import {Logger} from "./Logger";
import stringify from "fast-safe-stringify";
import {BitmovinMtHelper} from "./BitmovinMtHelper";
import {InternalBitmovinMtPlayer} from "./InternalBitmovinMtPlayer";
import {config} from "process";
import {Bitmovin8Adapter} from "bitmovin-analytics";
import {ArrayUtils} from "bitmovin-player-ui";

export class BitmovinMediaTailorPlayer implements BitmovinMediaTailorAPI {
    private player: BitmovinMediaTailorAPI;
    private bitmovinMtPlayer: BitmovinMediaTailorAPI;
    private bitmovinPlayer: PlayerAPI;
    private currentPlayerType: MediaTailorPlayerType = MediaTailorPlayerType.BitmovinMediaTailor;

    private BitmovinPlayerStaticApi: StaticPlayerAPI;
    private containerElement: HTMLElement;
    private config: PlayerConfig;
    private mtConfig: MtConfiguration

    private eventHandlers: { [eventType: string]: PlayerEventCallback[] } = {};

    constructor(BitmovinPlayerStaticApi: StaticPlayerAPI, containerElement: HTMLElement, config: PlayerConfig, mtConfig: MtConfiguration = {}) {
        this.BitmovinPlayerStaticApi = BitmovinPlayerStaticApi;
        this.containerElement = containerElement;
        this.config = config;
        this.mtConfig = mtConfig;

        if (mtConfig.debug) Logger.enable();

        // Clear advertising config
        if (config.advertising) {
            Logger.warn(
                'Client side advertising config is not supported. If you are using the BitmovinPlayer as' +
                'fallback please use player.ads.schedule'
            );
        }
        // add advertising again to load ads module
        config.advertising = {};

        if (config.ui === undefined || config.ui) {
            Logger.warn('Please setup the UI after initializing the MediaTailorPlayer');
            config.ui = false;
        }

        Logger.log('[BitmovinMtPlayer] creating BitmovinPlayer with configuration ' + stringify(this.config));

        this.createPlayer();

        if (
            mtConfig.useTizen &&
            !this.BitmovinPlayerStaticApi.getModules().includes(this.player.exports.ModuleName.Tizen)
        ) {
            Logger.warn('Built for WebOS usage but no BitmovinPlayer WebOS module found.');
        }
        if (
            mtConfig.useWebos &&
            !this.BitmovinPlayerStaticApi.getModules().includes(this.player.exports.ModuleName.Webos)
        ) {
            Logger.warn('Built for WebOS usage but no BitmovinPlayer WebOS module found.');
        }

    }

    setPolicy(policy: BitmovinMediaTailorPlayerPolicy): void {
        if (this.getCurrentPlayerType() === MediaTailorPlayerType.Bitmovin) {
            Logger.log(
                '[BitmovinMediaTailorPlayer] Policy does not apply for Bitmovin Player but is saved for further ' +
                'BitmovinMedaiTailor Player usage'
            );
        }

        this.bitmovinMtPlayer.setPolicy(policy);
    }

    private createPlayer(): void {
        if (BitmovinMtHelper.isSafari() || BitmovinMtHelper.isSafariIOS()) {
            if (!this.config.location) {
                this.config.location = {};
            }

            if (!this.config.tweaks) {
                this.config.tweaks = {};
            }

            if (!this.mtConfig.disableServiceWorker) {
                if (!this.config.location.serviceworker) {
                    this.config.location.serviceworker = './sw.js';
                }

                //if (!this.config.tweaks.native_hls_parsing) {
                //    this.config.tweaks.native_hls_parsing = true;
                //}
            }

            Logger.log('Loading the ServiceWorkerModule');
        }
        this.bitmovinPlayer = new this.BitmovinPlayerStaticApi(this.containerElement, this.config);

        this.bitmovinMtPlayer = new InternalBitmovinMtPlayer(
            this.containerElement,
            this.bitmovinPlayer,
            this.mtConfig
        ) as any as BitmovinMediaTailorAPI;

        this.player = this.bitmovinMtPlayer;
    }

    getCurrentPlayerType(): MediaTailorPlayerType {
        return this.currentPlayerType;
    }

    load(source: SourceConfig | MtSourceConfig): Promise<void> {
        Logger.log("BitmovinMediaTailorPlayer attempt loading of source")
        return new Promise<void>((resolve, reject) => {
            const isAssetTypePresent = (): boolean => (source as MtSourceConfig).assetType !== undefined;

            const switchPlayer = (toType: MediaTailorPlayerType) => {
                this.player
                    .unload()
                    .then(() => {
                        const oldPlayer: BitmovinMediaTailorAPI = this.player;
                        if (toType === MediaTailorPlayerType.Bitmovin) {
                            this.player = this.bitmovinPlayer as BitmovinMediaTailorAPI;
                        } else {
                            this.player = this.bitmovinMtPlayer;
                        }

                        this.currentPlayerType = toType;

                        new Bitmovin8Adapter(this.player);

                        Logger.log('BitmovinMediaTailorPlayer loading source after switching players- ' + stringify(source));

                        this.player.load(source).then(resolve).catch(reject);
                    })
                    .catch(reject);
            };

            // Only switch player when necessary
            if (!isAssetTypePresent() && this.currentPlayerType === MediaTailorPlayerType.BitmovinMediaTailor) {
                switchPlayer(MediaTailorPlayerType.Bitmovin);
            } else if (isAssetTypePresent() && this.currentPlayerType === MediaTailorPlayerType.Bitmovin) {
                switchPlayer(MediaTailorPlayerType.BitmovinMediaTailor);
            } else {
                new Bitmovin8Adapter(this.player);

                Logger.log('BitmovinMediaTailorPlayer loading source - ' + stringify(source));
                // Else load the source in the current player
                this.player.load(source).then(resolve).catch(reject);
            }
        });
    }

    forceSeek(time: number, issuer?: string): boolean {
        return this.player.forceSeek(time, issuer);
    }

    on(eventType: PlayerEvent, callback: PlayerEventCallback): void;

    on(eventType: PlayerEvent, callback:  PlayerEventCallback): void {
        if (!this.eventHandlers[eventType]) {
            this.eventHandlers[eventType] = [];
        }
        this.eventHandlers[eventType].push(callback);

        this.player.on(eventType, callback);
    }

    off(eventType: PlayerEvent, callback: PlayerEventCallback): void;

    off(eventType: PlayerEvent, callback: PlayerEventCallback): void {
        this.player.off(eventType, callback);
        ArrayUtils.remove(this.eventHandlers[eventType], callback);
    }

    // PlayerAPI Implementation
    // Default methods propagated to this.player
    destroy(): Promise<void> {
        return this.player.destroy();
    }

    get ads(): PlayerAdvertisingAPI {
        return this.player.ads;
    }

    get exports(): PlayerExports {
        return {
            ...this.player.exports,
        };
    }

    get adaptation(): AdaptationAPI {
        return this.player.adaptation;
    }

    get buffer(): PlayerBufferAPI {
        return this.player.buffer;
    }

    get lowlatency(): LowLatencyAPI {
        return this.player.lowlatency;
    }

    get subtitles(): PlayerSubtitlesAPI {
        return this.player.subtitles;
    }

    get version(): string {
        return this.player.version;
    }

    get vr(): PlayerVRAPI {
        return this.player.vr;
    }

    get manifest(): PlayerManifestAPI {
        return this.player.manifest;
    }

    addMetadata(metadataType: MetadataType.CAST, metadata: any): boolean {
        return this.player.addMetadata(metadataType, metadata);
    }

    castStop(): void {
        return this.player.castStop();
    }

    castVideo(): void {
        return this.player.castVideo();
    }

    clearQueryParameters(): void {
        return this.player.clearQueryParameters();
    }

    getAudio(): AudioTrack {
        return this.player.getAudio();
    }

    getAudioBufferLength(): number | null {
        return this.player.getAudioBufferLength();
    }

    getAudioQuality(): AudioQuality {
        return this.player.getAudioQuality();
    }

    getAvailableAudio(): AudioTrack[] {
        return this.player.getAvailableAudio();
    }

    getAvailableAudioQualities(): AudioQuality[] {
        return this.player.getAvailableAudioQualities();
    }

    getAvailableSegments(): SegmentMap {
        return this.player.getAvailableSegments();
    }

    getAvailableVideoQualities(): VideoQuality[] {
        return this.player.getAvailableVideoQualities();
    }

    getBufferedRanges(): TimeRange[] {
        return this.player.getBufferedRanges();
    }

    getConfig(mergedConfig?: boolean): PlayerConfig {
        return this.player.getConfig();
    }

    getContainer(): HTMLElement {
        return this.player.getContainer();
    }

    getCurrentTime(caller?: string): number {
        return this.player.getCurrentTime();
    }

    getDownloadedAudioData(): DownloadedAudioData {
        return this.player.getDownloadedAudioData();
    }

    getDownloadedVideoData(): DownloadedVideoData {
        return this.player.getDownloadedVideoData();
    }

    getDroppedVideoFrames(): number {
        return this.player.getDroppedVideoFrames();
    }

    getDuration(): number {
        return this.player.getDuration();
    }

    getManifest(): string {
        return this.player.getManifest();
    }

    getMaxTimeShift(): number {
        return this.player.getMaxTimeShift();
    }

    getPlaybackAudioData(): AudioQuality {
        return this.player.getPlaybackAudioData();
    }

    getPlaybackSpeed(): number {
        return this.player.getPlaybackSpeed();
    }

    getPlaybackVideoData(): VideoQuality {
        return this.player.getPlaybackVideoData();
    }

    getPlayerType(): PlayerType {
        return this.player.getPlayerType();
    }

    getSeekableRange(): TimeRange {
        return this.player.getSeekableRange();
    }

    getSnapshot(type?: string, quality?: number): Snapshot {
        return this.player.getSnapshot();
    }

    getSource(): SourceConfig | null {
        return this.player.getSource();
    }

    getStreamType(): StreamType {
        return this.player.getStreamType();
    }

    getSupportedDRM(): Promise<string[]> {
        return this.player.getSupportedDRM();
    }

    getSupportedTech(mode?: SupportedTechnologyMode): Technology[] {
        return this.player.getSupportedTech();
    }

    getThumbnail(time: number): Thumbnail {
        return this.player.getThumbnail(time);
    }

    getTimeShift(): number {
        return this.player.getTimeShift();
    }

    getTotalStalledTime(): number {
        return this.player.getTotalStalledTime();
    }

    getVideoBufferLength(): number | null {
        return this.player.getVideoBufferLength();
    }

    getVideoElement(): HTMLVideoElement {
        return this.player.getVideoElement();
    }

    getVideoQuality(): VideoQuality {
        return this.player.getVideoQuality();
    }

    getViewMode(): ViewMode {
        return this.player.getViewMode();
    }

    getVolume(): number {
        return this.player.getVolume();
    }

    hasEnded(): boolean {
        return this.player.hasEnded();
    }

    isAirplayActive(): boolean {
        return this.player.isAirplayActive();
    }

    isAirplayAvailable(): boolean {
        return this.player.isAirplayAvailable();
    }

    isCastAvailable(): boolean {
        return this.player.isCastAvailable();
    }

    isCasting(): boolean {
        return this.player.isCasting();
    }

    isDRMSupported(drmSystem: string): Promise<string> {
        return this.player.isDRMSupported(drmSystem);
    }

    isLive(): boolean {
        return this.player.isLive();
    }

    isMuted(): boolean {
        return this.player.isMuted();
    }

    isPaused(): boolean {
        return this.player.isPaused();
    }

    isPlaying(): boolean {
        return this.player.isPlaying();
    }

    isStalled(): boolean {
        return this.player.isStalled();
    }

    isViewModeAvailable(viewMode: ViewMode): boolean {
        return this.player.isViewModeAvailable(viewMode);
    }

    mute(issuer?: string): void {
        return this.player.mute();
    }

    pause(issuer?: string): void {
        return this.player.pause();
    }

    play(issuer?: string): Promise<void> {
        return this.player.play(issuer);
    }

    preload(): void {
        return this.player.preload();
    }

    seek(time: number, issuer?: string): boolean {
        return this.player.seek(time, issuer);
    }

    setAudio(trackID: string): void {
        return this.player.setAudio(trackID);
    }

    setAudioQuality(audioQualityID: string): void {
        return this.player.setAudioQuality(audioQualityID);
    }

    setAuthentication(customData: any): void {
        return this.player.setAuthentication(customData);
    }

    setLogLevel(level: LogLevel): void {
        return this.player.setLogLevel(level);
    }

    setPlaybackSpeed(speed: number): void {
        return this.player.setPlaybackSpeed(speed);
    }

    setPosterImage(url: string, keepPersistent: boolean): void {
        return this.player.setPosterImage(url, keepPersistent);
    }

    setQueryParameters(queryParameters: QueryParameters): void {
        return this.player.setQueryParameters(queryParameters);
    }

    setVideoElement(videoElement: HTMLElement): void {
        return this.player.setVideoElement(videoElement);
    }

    setVideoQuality(videoQualityID: string): void {
        return this.player.setVideoQuality(videoQualityID);
    }

    setViewMode(viewMode: ViewMode, options?: ViewModeOptions): void {
        return this.player.setViewMode(viewMode, options);
    }

    setVolume(volume: number, issuer?: string): void {
        return this.player.setVolume(volume, issuer);
    }

    showAirplayTargetPicker(): void {
        return this.player.showAirplayTargetPicker();
    }

    timeShift(offset: number, issuer?: string): void {
        return this.player.timeShift(offset, issuer);
    }

    unload(): Promise<void> {
        return this.player.unload();
    }

    unmute(issuer?: string): void {
        return this.player.unmute();
    }

    setAspectRatio(aspectratio: string | number): void {
        return this.player.setAspectRatio(aspectratio);
    }

    getAspectRatio(): number {
        return this.player.getAspectRatio();
    }

    readonly drm: DrmAPI;
}
