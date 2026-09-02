import { useMemo } from 'react'
import {
    Bar,
    BarChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts'

function trunc(s, max) {
    if (!s) {return ''}
    const t = String(s).trim()
    return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function PayrollMiniChart({ payroll }) {
    const data = useMemo(() => {
        if (!Array.isArray(payroll) || payroll.length === 0) {return []}
        return [...payroll]
            .map((p) => ({
                name: trunc(p.name, 16),
                due: Math.round(parseFloat(p.total_amount || 0) * 100) / 100,
            }))
            .sort((a, b) => b.due - a.due)
            .slice(0, 8)
    }, [payroll])

    if (data.length === 0) {return null}

    const h = Math.min(300, 72 + data.length * 34)

    return (
        <div className="adm-chart-strip">
            <div className="adm-chart-strip__head">
                <span className="adm-chart-strip__title">Payout distribution</span>
                <span className="adm-chart-strip__sub">Top staff by total due</span>
            </div>
            <div className="adm-chart-strip__canvas" style={{ height: h }}>
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                        layout="vertical"
                        data={data}
                        margin={{ left: 4, right: 12, top: 4, bottom: 4 }}
                        barCategoryGap={8}
                    >
                        <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="rgba(15, 23, 42, 0.06)" />
                        <XAxis
                            type="number"
                            tick={{ fontSize: 11, fill: '#64748b' }}
                            tickFormatter={(v) => `$${v}`}
                            axisLine={false}
                            tickLine={false}
                        />
                        <YAxis
                            type="category"
                            dataKey="name"
                            width={108}
                            tick={{ fontSize: 11, fill: '#334155' }}
                            tickLine={false}
                            axisLine={false}
                        />
                        <Tooltip
                            formatter={(value) => [`$${Number(value).toFixed(2)}`, 'Total due']}
                            contentStyle={{
                                borderRadius: 12,
                                border: '1px solid rgba(5, 150, 105, 0.25)',
                                boxShadow: '0 8px 28px rgba(15, 23, 42, 0.1)',
                            }}
                        />
                        <Bar dataKey="due" name="Total due" fill="#059669" radius={[0, 8, 8, 0]} maxBarSize={26} animationDuration={550} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    )
}

export function PerformanceMiniChart({ performance }) {
    const data = useMemo(() => {
        if (!Array.isArray(performance) || performance.length === 0) {return []}
        return [...performance]
            .map((p) => ({
                name: trunc(p.name, 14),
                score: parseInt(p.overall_avg || 0, 10),
            }))
            .filter((d) => d.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)
    }, [performance])

    if (data.length === 0) {return null}

    const h = Math.min(320, 72 + data.length * 32)

    return (
        <div className="adm-chart-strip adm-chart-strip--perf">
            <div className="adm-chart-strip__head">
                <span className="adm-chart-strip__title">Score leaders</span>
                <span className="adm-chart-strip__sub">Overall QPS average (graded staff)</span>
            </div>
            <div className="adm-chart-strip__canvas" style={{ height: h }}>
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                        layout="vertical"
                        data={data}
                        margin={{ left: 4, right: 12, top: 4, bottom: 4 }}
                        barCategoryGap={8}
                    >
                        <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="rgba(15, 23, 42, 0.06)" />
                        <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                        <YAxis
                            type="category"
                            dataKey="name"
                            width={100}
                            tick={{ fontSize: 11, fill: '#334155' }}
                            tickLine={false}
                            axisLine={false}
                        />
                        <Tooltip
                            formatter={(value) => [`${value}`, 'Overall']}
                            contentStyle={{
                                borderRadius: 12,
                                border: '1px solid rgba(234, 88, 12, 0.28)',
                                boxShadow: '0 8px 28px rgba(15, 23, 42, 0.1)',
                            }}
                        />
                        <Bar dataKey="score" name="Overall" fill="#ea580c" radius={[0, 8, 8, 0]} maxBarSize={26} animationDuration={550} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    )
}
