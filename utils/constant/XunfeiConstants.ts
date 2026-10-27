// utils/constant/XunfeiConstants.ts
/** 讯飞（音色训练 / 语音识别）服务常量 */
import { envStr } from './envParse.ts';

export class XunfeiConstants {
  /** 鉴权 token 接口 */
  public static readonly AUTH_URL: string = 'http://avatar-hci.xfyousheng.com/aiauth/v1/token';

  /** 应用 id（XUNFEI_APPID） */
  public static readonly APPID: string = envStr('XUNFEI_APPID');

  /** 应用 APIKey（XUNFEI_APIKey） */
  public static readonly API_KEY: string = envStr('XUNFEI_APIKey');

  /** 应用 APISecret（XUNFEI_APISecret） */
  public static readonly API_SECRET: string = envStr('XUNFEI_APISecret');

  /** 训练文本接口 */
  public static readonly TRAINTEXT_URL: string = 'http://opentrain.xfyousheng.com/voice_train/task/traintext';

  /** 创建训练任务接口 */
  public static readonly TRAINTCREATE_URL: string = 'http://opentrain.xfyousheng.com/voice_train/task/add';

  /** 训练任务地址前缀 */
  public static readonly TRAINTCREATE_BACK_URL: string = 'http://opentrain.xfyousheng.com/voice_train/task';

  /** 提交音频训练接口 */
  public static readonly TRAINT_ADDSUBMIT_URL: string = 'http://opentrain.xfyousheng.com/voice_train/task/submitWithAudio';

  /** 训练结果查询接口 */
  public static readonly TRAINT_RESULT_URL: string = 'http://opentrain.xfyousheng.com/voice_train/task/result';

  /** 语音转写上传接口 */
  public static readonly RAASR_URL: string = 'https://office-api-ist-dx.iflyaisol.com/v2/upload';

  /** 语音转写结果接口 */
  public static readonly RAASR_RESULT_URL: string = 'https://office-api-ist-dx.iflyaisol.com/v2/getResult';

  /** 音色克隆合成 WebSocket 地址 */
  public static readonly VOICE_CLONE_URL: string = 'wss://cn-huabei-1.xf-yun.com/v1/private/voice_clone';

  /** 文本 id */
  public static readonly TEXTID: string = '5001';

  /** 音色训练完成回调地址（XUNFEI_TRAIN_CALLBACK） */
  public static readonly TRAIN_CALLBACK: string = envStr('XUNFEI_TRAIN_CALLBACK');
}
