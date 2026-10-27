import AxiosService from '../Axios.ts';
import { Logger } from '../Logger.ts';
import { SystemConstants } from '../constant/SystemConstants.ts';



const instance = AxiosService.getInstance();
const logger = Logger.getInstance();


export const getVersion=async ():Promise<string>=>{
    logger.info(`获取云端版本`)
      const prefix= process.env.NODE_ENV==='development'?"/dev":""

    const url = SystemConstants.SERVER_URL+prefix+'/hip/api/system/cloudVersion'
    const res = await instance.get<ResultVO<string>>(url)
    return res.data as string
}