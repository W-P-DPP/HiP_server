export { }

declare global {
    interface ResultVO<T = any> {
        code: number
        msg: string
        data?: T
        timestamp?: number,
        [key:string]: any
    }

}
