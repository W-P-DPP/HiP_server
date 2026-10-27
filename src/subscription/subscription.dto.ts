/** 订阅入参 */
export interface SubscribeDto {
  userId: string;
  skillKey: string;
}

/** 订阅查询参数 */
export interface SubscriptionQueryDto {
  userId: string;
  status?: string;
}
