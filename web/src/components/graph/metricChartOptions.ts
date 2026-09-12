import type { ApexOptions } from "apexcharts";

type MetricChartOptions = {
  graphId: string;
  theme: string;
  mobile: boolean;
  formatTime: (value: string) => string;
  yMax?: number;
};

/** Build independent axis and interaction options for each metric chart. */
export function createMetricChartOptions({
  graphId,
  theme,
  mobile,
  formatTime,
  yMax,
}: Readonly<MetricChartOptions>): ApexOptions {
  return {
    chart: {
      id: graphId,
      selection: {
        enabled: false,
      },
      toolbar: {
        show: false,
      },
      zoom: {
        enabled: false,
      },
    },
    grid: {
      show: false,
    },
    legend: {
      show: false,
    },
    dataLabels: {
      enabled: false,
    },
    tooltip: {
      theme,
    },
    markers: {
      size: 0,
    },
    xaxis: {
      tickAmount: mobile ? 2 : 3,
      tickPlacement: "on",
      labels: {
        rotate: 0,
        formatter: formatTime,
        style: {
          colors: "#6B6B6B",
        },
      },
      axisBorder: {
        show: false,
      },
      axisTicks: {
        show: false,
      },
    },
    yaxis: {
      show: true,
      labels: {
        formatter: (val: number) => Math.ceil(val).toString(),
        style: {
          colors: "#6B6B6B",
        },
      },
      min: 0,
      max: yMax,
    },
  };
}
