import { useEffect, useRef, useState } from 'react';
// Intentional ECharts imports: this module is loaded only through React.lazy in AnalyticsPage.
// eslint-disable-next-line no-restricted-imports
import { init, use as registerCharts } from 'echarts/core';
// eslint-disable-next-line no-restricted-imports
import { BarChart, LineChart } from 'echarts/charts';
// eslint-disable-next-line no-restricted-imports
import { AriaComponent, GridComponent, LegendComponent, DataZoomComponent } from 'echarts/components';
// eslint-disable-next-line no-restricted-imports
import { SVGRenderer } from 'echarts/renderers';
import { chartOptions } from './options';
import type { ChartModel, Explanation } from './options';
registerCharts([BarChart, LineChart, GridComponent, LegendComponent, AriaComponent, DataZoomComponent, SVGRenderer]);
export default function Chart({ model, onSelect }: { model: ChartModel; onSelect(selection: Explanation): void }) {
  const element = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!element.current || !model.rows.length) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let active = true;
    let instance: ReturnType<typeof init> | undefined;
    let observer: ResizeObserver | undefined;
    const click = (event: unknown) => {
      const { seriesIndex, dataIndex } = event as { seriesIndex: number; dataIndex: number };
      if (seriesIndex === 0 && Number.isInteger(dataIndex) && model.rows[dataIndex]) onSelect(model.rows[dataIndex]!.explanation);
    };
    const updateMotion = () => instance?.setOption(chartOptions(model, motion.matches), { notMerge: true });
    try {
      instance = init(element.current, undefined, { renderer: 'svg' });
      updateMotion(); instance.on('click', click);
      observer = new ResizeObserver(() => instance?.resize()); observer.observe(element.current);
      motion.addEventListener('change', updateMotion);
    } catch { queueMicrotask(() => { if (active) setFailed(true); }); }
    return () => { active = false; motion.removeEventListener('change', updateMotion); observer?.disconnect(); instance?.off('click', click); instance?.dispose(); };
  }, [model, onSelect]);
  return failed ? <p role="status">Visualização indisponível. Consulte os mesmos dados e ações na tabela abaixo.</p> : <div ref={element} className="analytics-chart" role="img" aria-label={`${model.title}. ${model.population}. ${model.description} Tabela e ações abaixo.`} />;
}
