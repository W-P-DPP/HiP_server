// videoHelper barrel export
export { toVideo, type ToVideoResult } from './toVideo.ts'
export { runFfmpeg } from './ffmpeg.ts'
export { extractAudioToWav } from './extractAudio.ts'
export {
    burnSubtitlesIntoVideo,
    buildSubtitleBurnFilter,
    escapeFilterPath,
    type BurnSubtitleStyle,
} from './burnSubtitles.ts'
export { parseSrt, cleanCueText, type SrtCue } from './srt.ts'
export { probeDurationSec, probeDurationMs } from './probe.ts'
export { searchVideo, downloadVideo } from './pixabay.ts'
export { normalizeKeyword, sanitizeKeyword, similarityScore } from './similarity.ts'
export { resolveClipForKeyword, resolveLibraryMaterial, saveLibraryMaterial, getMaterialsDir, type ResolvedClip } from './materialLibrary.ts'
export { clipMediaKind, clipInputArgs, type ClipMediaKind } from './mediaKind.ts'
export { buildBackgroundTrack, type BuildBackgroundOptions } from './background.ts'
export { detectScenes } from './sceneDetect.ts'
export { detectBlackFrames, parseBlackDetectRanges, type BlackDetectOptions } from './blackDetect.ts'
export { extractFrame, type ExtractFrameOptions } from './frameExtract.ts'
export { extractAudioClip, type ExtractAudioClipOptions } from './audioClip.ts'
export {
    downloadRemoteMedia,
    assertPublicHttpUrl,
    isPrivateAddress,
    guessMediaExt,
    type DownloadRemoteOptions,
    type DownloadRemoteResult,
    type PublicUrlCheck,
} from './remoteDownload.ts'
