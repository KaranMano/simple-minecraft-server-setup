import { useEffect, useRef, useState } from 'react';
import { MoonOutlined, PlusOutlined, SunOutlined } from '@ant-design/icons';
import { Line } from '@ant-design/plots';
import {
  App as AntApp,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  ConfigProvider,
  Flex,
  Form,
  Input,
  Listy,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';

type User = { username: string; admin: boolean; permissions: string[] };
type PanelUser = { id: string; username: string; admin: boolean; permissions: string[] };
type Backup = { name: string; createdAt: string; size: number };
type Field = { name: string; label: string; placeholder?: string; options?: string[]; required?: boolean };
type Command = { id: string; label: string; fields: Field[] };
type Status = { server?: { running: boolean; pid?: number }; logs?: string; backups?: Backup[]; nextBackup?: string; lifecycle?: { type: string; phase: string; startedAt: string } | null };

const featureNames: Record<string, string> = { 'server.control': 'Lifecycle', 'server.console': 'Console', 'server.metrics': 'Metrics', 'server.rcon': 'RCON', 'server.backups': 'Backups', 'users.manage': 'Users' };

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-Panel-Poll': 'true', ...(options.headers || {}) } });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const formatDate = (value?: string) => value ? new Date(value).toLocaleString() : 'Not scheduled';
const formatSize = (bytes = 0) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const METRICS_WINDOW_MS = 5 * 60 * 1000;
type MetricSample = { timestamp: number; cpuPercent: number; cpuCores: number; memoryUsedMb: number; memoryLimitMb: number };
type MetricsResponse = { intervalMs: number; windowMs: number; oldestTimestamp: number | null; latestTimestamp: number | null; reset: boolean; points: MetricSample[] };
type MetricPoint = { time: number; elapsed: number; series: string; value: number };
function toSeries(history: MetricSample[], windowStart: number): MetricPoint[] {
  const points: MetricPoint[] = [];
  for (const point of history) {
    const elapsed = Math.max(0, point.timestamp - windowStart);
    points.push({ time: point.timestamp, elapsed, series: 'CPU', value: point.cpuPercent });
    points.push({ elapsed, time: point.timestamp, series: 'Memory', value: point.memoryLimitMb > 0 ? (point.memoryUsedMb / point.memoryLimitMb) * 100 : 0 });
  }
  return points;
}

export default function App() {
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('paper-control-theme') !== 'light');
  const algorithm = darkMode ? theme.darkAlgorithm : theme.defaultAlgorithm;
  const tokens = algorithm(theme.defaultSeed);
  useEffect(() => {
    localStorage.setItem('paper-control-theme', darkMode ? 'dark' : 'light');
    document.body.style.backgroundColor = tokens.colorBgLayout;
    document.body.style.colorScheme = darkMode ? 'dark' : 'light';
  }, [darkMode]);
  return (
    <ConfigProvider theme={{ algorithm }}>
      <AntApp>
        <Shell darkMode={darkMode} setDarkMode={setDarkMode} />
      </AntApp>
    </ConfigProvider>
  );
}

function Shell({ darkMode, setDarkMode }: { darkMode: boolean; setDarkMode: (value: boolean) => void }) {
  const [session, setSession] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>({});
  const [commands, setCommands] = useState<Command[]>([]);
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [metricsHistory, setMetricsHistory] = useState<MetricSample[]>([]);
  const metricsCursor = useRef<number | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const { message } = AntApp.useApp();
  const fetchMetrics = async () => {
    const since = metricsCursor.current;
    const query = since === undefined ? '' : `?since=${since}`;
    const response = await request<MetricsResponse>(`/api/metrics${query}`);
    if (since === undefined || response.reset) setMetricsHistory(response.points);
    else if (response.points.length) setMetricsHistory(history => [...history, ...response.points.filter(point => point.timestamp > (history.at(-1)?.timestamp || 0))]);
    metricsCursor.current = response.latestTimestamp ?? metricsCursor.current;
  };
  const refresh = async () => {
    const current = await request<{ user: User | null }>('/api/session');
    setSession(current.user);
    if (current.user) {
      const nextStatus = await request<Status>('/api/status');
      setStatus(nextStatus);
      await fetchMetrics();
      setCommands((await request<{ commands: Command[] }>('/api/commands')).commands);
      if (current.user.permissions.includes('users.manage')) {
        setUsers((await request<{ users: PanelUser[] }>('/api/users')).users);
      }
    }
    setLoaded(true);
  };
  useEffect(() => {
    if (!session) metricsCursor.current = undefined;
    refresh().catch(error => { message.error(error.message); setLoaded(true); });
    const timer = setInterval(() => session && Promise.all([request<Status>('/api/status'), fetchMetrics()]).then(([nextStatus]) => setStatus(nextStatus)).catch(() => { }), 3000);
    return () => clearInterval(timer);
  }, [session?.username]);
  if (!loaded) return <Flex justify="center" align="center" style={{ minHeight: '100vh' }}><Spin size="large" /></Flex>;
  if (!session) return <Login onLogin={setSession} darkMode={darkMode} setDarkMode={setDarkMode} />;
  return <Dashboard session={session} status={status} commands={commands} users={users} metricsHistory={metricsHistory} refresh={refresh} darkMode={darkMode} setDarkMode={setDarkMode} />;
}

function ThemeToggle({ darkMode, setDarkMode }: { darkMode: boolean; setDarkMode: (value: boolean) => void }) {
  const label = darkMode ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <Tooltip title={label}>
      <Button aria-label={label} icon={darkMode ? <SunOutlined /> : <MoonOutlined />} onClick={() => setDarkMode(!darkMode)} />
    </Tooltip>
  );
}

function Login({ onLogin, darkMode, setDarkMode }: { onLogin: (user: User) => void; darkMode: boolean; setDarkMode: (value: boolean) => void }) {
  const { message } = AntApp.useApp();
  return (
    <Flex vertical style={{ minHeight: '100vh' }}>
      <Flex justify="flex-end" style={{ padding: 16 }}>
        <ThemeToggle darkMode={darkMode} setDarkMode={setDarkMode} />
      </Flex>
      <Flex justify="center" align="center" flex={1}>
        <Card style={{ width: 360 }}>
          <Typography.Title level={2}>Paper Control</Typography.Title>
          <Typography.Paragraph type="secondary">Local server operations</Typography.Paragraph>
          <Form
            layout="vertical"
            onFinish={async values => {
              try {
                await request('/api/login', { method: 'POST', body: JSON.stringify(values) });
                onLogin((await request<{ user: User }>('/api/session')).user);
              } catch (error) {
                message.error((error as Error).message);
              }
            }}
          >
            <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Enter your username' }]}>
              <Input autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="Password" rules={[{ required: true, message: 'Enter your password' }]}>
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block>Sign in</Button>
          </Form>
        </Card>
      </Flex>
    </Flex>
  );
}

function Dashboard({ session, status, commands, users, metricsHistory, refresh, darkMode, setDarkMode }: { session: User; status: Status; commands: Command[]; users: PanelUser[]; metricsHistory: MetricSample[]; refresh: () => Promise<void>; darkMode: boolean; setDarkMode: (value: boolean) => void }) {
  const { message } = AntApp.useApp();
  const has = (key: string) => session.permissions.includes(key);
  const operation = status.lifecycle;
  const online = !!status.server?.running;
  const action = async (fn: () => Promise<any>, success: string) => {
    try {
      const result = await fn();
      message.success(result.output || success);
      await refresh();
    } catch (error) {
      message.error((error as Error).message);
    }
  };
  return (
    <Flex vertical gap="large" style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <Flex justify="space-between" align="center" wrap gap="small">
        <div>
          <Typography.Title level={2} style={{ marginBottom: 0 }}>Paper Control</Typography.Title>
          <Typography.Text type="secondary">
            {session.username} · {online ? 'server online' : 'server offline'}
          </Typography.Text>
        </div>
        <Space>
          <ThemeToggle darkMode={darkMode} setDarkMode={setDarkMode} />
          <Button onClick={() => action(() => request('/api/logout', { method: 'POST' }), 'Signed out')}>Sign out</Button>
        </Space>
      </Flex>
      <Row gutter={[16, 16]} style={{ alignItems: 'stretch' }}>
        <Col xs={24} lg={12} style={{ display: 'flex' }}>
          <Card title="Server state" style={{ width: '100%' }}>
            <Typography.Title level={3} type={online ? 'success' : 'secondary'}>
              <Badge status={online ? 'processing' : 'default'} /> {online ? 'ONLINE' : 'OFFLINE'}
            </Typography.Title>
            <Typography.Paragraph type="secondary">
              {online ? `PID ${status.server?.pid || 'container'}` : 'Ready to launch Paper'}
            </Typography.Paragraph>
            {has('server.control') && (
              <Space wrap>
                {(['start', 'stop', 'restart'] as const).map(name => (
                  <Button
                    key={name}
                    danger={name === 'stop'}
                    disabled={!!operation}
                    onClick={() => action(() => request(`/api/server/${name}`, { method: 'POST' }), `${name} completed`)}
                  >
                    {name}
                  </Button>
                ))}
              </Space>
            )}
          </Card>
        </Col>
        {has('server.backups') && (
          <Col xs={24} lg={12} style={{ display: 'flex' }}>
            <Card title="World safety" style={{ width: '100%' }}>
              <Typography.Paragraph type="secondary">Next automatic backup: {formatDate(status.nextBackup)}</Typography.Paragraph>
              {operation && (
                <Flex vertical gap="small">
                  <Typography.Text strong>{operation.type}: {operation.phase}</Typography.Text>
                  <Progress percent={100} status="active" showInfo={false} />
                </Flex>
              )}
              <Button
                disabled={!!operation}
                onClick={() => action(() => request('/api/backup', { method: 'POST' }), 'Backup completed')}
              >
                Create backup
              </Button>
              {status.backups?.length ? (
                <Listy
                  items={status.backups}
                  rowKey="name"
                  itemRender={backup => (
                    <Flex justify="space-between" align="center" gap="middle">
                      <Flex vertical>
                        <Typography.Text code>{backup.name}</Typography.Text>
                        <Typography.Text type="secondary">{formatDate(backup.createdAt)} · {formatSize(backup.size)}</Typography.Text>
                      </Flex>
                      <Popconfirm
                        title={`Restore ${backup.name}?`}
                        onConfirm={() => action(() => request('/api/backups/restore', { method: 'POST', body: JSON.stringify({ name: backup.name }) }), 'Backup restored')}
                      >
                        <Button size="small" disabled={!!operation}>Restore</Button>
                      </Popconfirm>
                    </Flex>
                  )}
                />
              ) : (
                <Typography.Text type="secondary">No backups yet.</Typography.Text>
              )}
            </Card>
          </Col>
        )}
        {has('server.metrics') && (
          <Col xs={24}>
            <Card title="Minecraft resources">
              <MetricsChart history={metricsHistory} />
            </Card>
          </Col>
        )}
      </Row>
      <Card title="Command deck">
        <Flex vertical gap="large">
          <CommandForm commands={commands} disabled={!!operation} />
          <Input.TextArea value={status.logs || 'No live output yet.'} readOnly rows={16} />
        </Flex>
      </Card>
      <Card
        title="Access"
        extra={
          session.admin && (
            <CreateUser
              onCreate={values => action(
                () => request('/api/users', { method: 'POST', body: JSON.stringify(values) }),
                `User ${values.username} created`,
              )}
            />
          )
        }
      >
        <Typography.Paragraph type="secondary">
          Your account has {session.admin ? 'administrator access' : 'limited permissions'}.
        </Typography.Paragraph>
        {session.admin && <UserTable users={users} session={session} action={action} />}
      </Card>
    </Flex>
  );
}

const SERIES_COLORS: Record<string, string> = { CPU: '#5470c6', Memory: '#52c41a' };

function MetricsChart({ history }: { history: MetricSample[] }) {
  const {
    token: { colorTextSecondary, colorBorderSecondary, colorBgContainer, colorText },
  } = theme.useToken();
  // Anchor the window to the first sample so the graph grows from the left (0s) toward 10m.
  const windowStart = history.length ? history[0].timestamp : Date.now();
  const data = toSeries(history, windowStart);
  const latestSample = history.at(-1);
  const latest = (series: string) => {
    const points = data.filter(point => point.series === series);
    return points.length ? points[points.length - 1].value : 0;
  };
  return (
    <Flex vertical gap="small">
      <Flex gap="large">
        <Typography.Text style={{ color: SERIES_COLORS.CPU }}>CPU {latestSample?.cpuPercent.toFixed(1) || '—'}% of {latestSample?.cpuCores || '—'} cores</Typography.Text>
        <Typography.Text style={{ color: SERIES_COLORS.Memory }}>Memory {latestSample?.memoryUsedMb || '—'} MB of {latestSample?.memoryLimitMb || '—'} MB ({latest('Memory').toFixed(1)}%)</Typography.Text>
      </Flex>
      <Line
          data={data}
          xField="elapsed"
          yField="value"
          seriesField="series"
          colorField="series"
          height={220}
          autoFit
          smooth
          animation={false}
          point={false}
          scale={{ x: { domain: [0, METRICS_WINDOW_MS] }, y: { domain: [0, 100] }, color: { domain: ['CPU', 'Memory'], range: [SERIES_COLORS.CPU, SERIES_COLORS.Memory] } }}
          area={{ style: { fillOpacity: 0.18 } }}
          legend={false}
          axis={{
            x: {
              title: 'time',
              tickCount: 11,
              labelFormatter: (elapsed: number) => formatElapsed(elapsed),
              labelFill: colorTextSecondary,
              lineStroke: colorBorderSecondary,
              tickStroke: colorBorderSecondary,
              titleFill: colorTextSecondary,
            },
            y: {
              title: '%',
              labelFormatter: (value: number) => `${value}`,
              labelFill: colorTextSecondary,
              lineStroke: colorBorderSecondary,
              tickStroke: colorBorderSecondary,
              titleFill: colorTextSecondary,
              gridStroke: colorBorderSecondary,
              gridLineDash: [4, 4],
            },
          }}
          tooltip={{
            title: (datum: MetricPoint) => formatElapsed(datum.elapsed),
            formatter: (datum: MetricPoint) => ({ name: datum.series, value: `${datum.value.toFixed(1)}%` }),
            domStyles: {
              'g2-tooltip': { backgroundColor: colorBgContainer, color: colorText, boxShadow: 'none' },
              'g2-tooltip-title': { color: colorTextSecondary },
            },
          }}
      />
    </Flex>
  );
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function CommandForm({ commands, disabled }: { commands: Command[]; disabled: boolean }) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const id = Form.useWatch('id', form);
  const command = commands.find(item => item.id === id) || commands[0];
  useEffect(() => {
    if (command && form.getFieldValue('id') !== command.id) form.setFieldValue('id', command.id);
  }, [command?.id]);
  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={async values => {
        const { id: commandId, ...rest } = values;
        try {
          const result = await request<{ output?: string }>('/api/command', { method: 'POST', body: JSON.stringify({ id: commandId, values: rest }) });
          message.success(result.output || 'Command sent.');
        } catch (error) {
          message.error((error as Error).message);
        }
      }}
    >
      <Row gutter={[16, 0]} align="bottom">
        <Col xs={24} md={8} lg={6}>
          <Form.Item name="id" label="Command">
            <Select options={commands.map(item => ({ value: item.id, label: item.label }))} />
          </Form.Item>
        </Col>
        {command?.fields.map(field => (
          <Col xs={24} md={8} lg={6} key={`${command.id}.${field.name}`}>
            <Form.Item
              name={field.name}
              label={field.label}
              preserve={false}
              rules={field.required ? [{ required: true, message: `${field.label} is required` }] : undefined}
            >
              {field.options
                ? <Select options={field.options.map(option => ({ value: option, label: option }))} />
                : <Input placeholder={field.placeholder} />}
            </Form.Item>
          </Col>
        ))}
        <Col flex="auto">
          <Form.Item label={<span style={{ visibility: 'hidden' }}>\u00a0</span>} colon={false}>
            <Button type="primary" htmlType="submit" disabled={disabled || !commands.length}>Run command</Button>
          </Form.Item>
        </Col>
      </Row>
    </Form>
  );
}

function CreateUser({ onCreate }: { onCreate: (values: { username: string; password: string; admin: boolean; permissions: string[] }) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const permissionOptions = Object.entries(featureNames).map(([value, label]) => ({ value, label }));
  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>New user</Button>
      <Modal
        title="Create user"
        open={open}
        okText="Create"
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ admin: false, permissions: [] }}
          onFinish={async values => { await onCreate(values); form.resetFields(); setOpen(false); }}
        >
          <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Enter a username' }]}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true, message: 'Enter a password' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="admin" valuePropName="checked">
            <Checkbox>Administrator (grants every permission)</Checkbox>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.admin !== b.admin}>
            {({ getFieldValue }) => !getFieldValue('admin') && (
              <Form.Item name="permissions" label="Permissions">
                <Checkbox.Group options={permissionOptions} />
              </Form.Item>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function UserTable({ users, session, action }: { users: PanelUser[]; session: User; action: (fn: () => Promise<any>, success: string) => Promise<void> }) {
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const permissionOptions = Object.entries(featureNames).map(([value, label]) => ({ value, label }));
  const effectivePermissions = (user: PanelUser) => drafts[user.id] ?? (user.admin ? Object.keys(featureNames) : user.permissions);
  return (
    <Table
      rowKey="id"
      dataSource={users}
      pagination={false}
      columns={[
        {
          title: 'User',
          dataIndex: 'username',
          render: (username: string, user) => (
            <Space>
              {username}
              {user.admin && <Tag color="gold">ADMIN</Tag>}
            </Space>
          ),
        },
        {
          title: 'Permissions',
          render: (_, user) => (
            <Checkbox.Group
              options={permissionOptions}
              value={effectivePermissions(user)}
              onChange={values => setDrafts(current => ({ ...current, [user.id]: values as string[] }))}
            />
          ),
        },
        {
          title: '',
          render: (_, user) => (
            <Space>
              <Button
                size="small"
                onClick={() => action(
                  () => request(`/api/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ permissions: effectivePermissions(user), admin: user.admin }) }),
                  'Access updated',
                )}
              >
                Save
              </Button>
              {user.username !== session.username && (
                <Popconfirm
                  title={`Delete ${user.username}?`}
                  okText="Delete"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => action(() => request(`/api/users/${user.id}`, { method: 'DELETE' }), `User ${user.username} deleted`)}
                >
                  <Button size="small" danger>Delete</Button>
                </Popconfirm>
              )}
            </Space>
          ),
        },
      ]}
    />
  );
}
