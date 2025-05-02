import {
    PlayerAPI,
    PlayerEvent,
    PlayerEventCallback,
    SourceConfig,
} from 'bitmovin-player';
import {BitmovinMediaTailorPlayerPolicy, MediaTailorPlayerType, MtSourceConfig} from "./MediaTailorTypes";

export interface BitmovinMediaTailorAPI extends PlayerAPI {
    load(source: SourceConfig | MtSourceConfig): Promise<void>;
    on(eventType: PlayerEvent, callback: PlayerEventCallback): void;
    off(eventType: PlayerEvent, callback: PlayerEventCallback): void;
    getCurrentPlayerType(): MediaTailorPlayerType;
    setPolicy(policy: BitmovinMediaTailorPlayerPolicy): void;
    forceSeek(time: number, issuer?: string): boolean;
}

