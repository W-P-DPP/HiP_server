
// src/infra/typeorm/BaseSchema.ts
import type { EntitySchemaColumnOptions } from "typeorm"
import  dayjs from "dayjs"
export abstract class BaseEntity {
  createBy?: string
  createTime?: Date
  updateBy?: string
  updateTime?: Date
  remark?: string

  params?: any
}
export const BaseSchemaColumns: Record<
  keyof Omit<BaseEntity, "params">,
  EntitySchemaColumnOptions
> = {
  createBy: {
    name: "create_by",
    type: String,
    length: 64,
    nullable: true,
    comment: "创建者",
    select: false,
  },

  createTime: {
    name: "create_time",
    type: "datetime",
    createDate: true,
    comment: "创建时间",
    select: false,
    transformer: {
      from(value?: Date) {
        return value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : null
      },
      to(value?: Date) {
        return value
      },
    },
  },

  updateBy: {
    name: "update_by",
    type: String,
    length: 64,
    nullable: true,
    comment: "更新者",
    select: false,
  },

  updateTime: {
    name: "update_time",
    type: "datetime",
    updateDate: true,
    comment: "更新时间",
    select: false,
    transformer: {
      from(value?: Date) {
        return value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : null
      },
      to(value?: Date) {
        return value
      },
    },
  },

  remark: {
    name: "remark",
    type: String,
    nullable: true,
    comment: "备注",
    select: false,
  },
}
