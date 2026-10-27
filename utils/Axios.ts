import axios from 'axios';
import type { AxiosInstance as AxiosInstanceType, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { AxiosConstants } from './constant/AxiosConstants.ts';
import { Logger } from './index.ts';

class AxiosService {
    private static instance: AxiosService;
    private axiosInstance: AxiosInstanceType;
    private logger = Logger.getInstance();

    private constructor() {
        this.axiosInstance = axios.create({
            baseURL: AxiosConstants.BASE_URL,
            timeout: AxiosConstants.TIMEOUT,
        });

        this.setupInterceptors();
    }

    public static getInstance(): AxiosService {
        if (!AxiosService.instance) {
            AxiosService.instance = new AxiosService();
        }
        return AxiosService.instance;
    }

    private setupInterceptors() {
        // Request Interceptor
        this.axiosInstance.interceptors.request.use(
            (config: InternalAxiosRequestConfig) => {
                this.logger.info(`[Axios Request] ${config.method?.toUpperCase()} ${config.url}`);
                return config;
            },
            (error) => {
                this.logger.error(`[Axios Request Error] ${error}`);
                return Promise.reject(error);
            }
        );

        // Response Interceptor
        this.axiosInstance.interceptors.response.use(
            (response: AxiosResponse) => {
                this.logger.info(`[Axios Response] ${response.status} ${response.config.url} ${JSON.stringify(response.data)}`);
                return response;
            },
            (error) => {
                const message = error.message || 'Unknown Error';
                this.logger.error(`[Axios Response Error] ${message}`);
                if (error.response) {
                     this.logger.error(`[Axios Response Data] ${JSON.stringify(error.response.data)}`);
                }
                return Promise.reject(error);
            }
        );
    }

    public getAxios(): AxiosInstanceType {
        return this.axiosInstance;
    }

    public async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
        const response = await this.axiosInstance.get<T>(url, config);
        return response.data;
    }

    public async post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
        const response = await this.axiosInstance.post<T>(url, data, config);
        return response.data;
    }

    public async put<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
        const response = await this.axiosInstance.put<T>(url, data, config);
        return response.data;
    }

    public async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
        const response = await this.axiosInstance.delete<T>(url, config);
        return response.data;
    }
}

export default AxiosService;
