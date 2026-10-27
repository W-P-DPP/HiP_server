import OAuthClientModel, { type OAuthClientDocument } from './oauthClient.entity.ts';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth';

class OAuthClientRepository {
  /** 创建已注册客户端 */
  async create(client: OAuthClientInformationFull): Promise<OAuthClientDocument> {
    return OAuthClientModel.create({
      clientId: client.client_id,
      data: client as unknown as Record<string, unknown>,
      flag: 1,
    });
  }

  /** 按 clientId 查找（仅未删除） */
  async findByClientId(clientId: string): Promise<OAuthClientDocument | null> {
    return OAuthClientModel.findOne({
      clientId,
      flag: 1,
    }).exec();
  }

  /** 文档 → OAuthClientInformationFull（data 原样返回） */
  toInfo(doc: OAuthClientDocument): OAuthClientInformationFull {
    return doc.data as unknown as OAuthClientInformationFull;
  }
}

export const oauthClientRepository = new OAuthClientRepository();
