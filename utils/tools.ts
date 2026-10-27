

export function removeEmptyKeys<T extends Record<string, any>>(obj: T): T {
  (Object.keys(obj) as Array<keyof T>).forEach(key => {
    const value = obj[key];
    // 判断是否为空：null、undefined、空字符串
    if (value === null || value === undefined || value === '') {
      delete obj[key];
    }
  });
  return obj;
}