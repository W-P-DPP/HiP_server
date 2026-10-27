export namespace MCP {
    interface AlertFeature {
        properties: {
            event?: string;
            areaDesc?: string;
            severity?: string;
            status?: string;
            headline?: string;
        };
    }
    interface AlertsResponse {
        features: AlertFeature[];
    }

    interface PointsResponse {
        properties: {
            forecast?: string;
        };
    }

    interface ForecastResponse {
        properties: {
            periods: ForecastPeriod[];
        };
    }

interface ForecastPeriod {
  name?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
}

}