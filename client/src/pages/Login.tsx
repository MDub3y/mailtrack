import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface FormData { email: string; password: string; }

export const Login = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const { register, handleSubmit, formState: { errors, isSubmitting }, setError } = useForm<FormData>();

  const onSubmit = async (data: FormData) => {
    try { await login(data.email, data.password); navigate('/sent'); }
    catch { setError('root', { message: 'Invalid email or password' }); }
  };

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.logo}>✉</div>
        <h1 style={s.title}>MailTrack</h1>
        <p style={s.subtitle}>Sign in to your account</p>

        <form onSubmit={handleSubmit(onSubmit)} style={s.form}>
          <div style={s.field}>
            <label style={s.label}>Email</label>
            <input style={s.input} type="email" placeholder="you@example.com"
              {...register('email', { required: true })} />
          </div>
          <div style={s.field}>
            <label style={s.label}>Password</label>
            <input style={s.input} type="password" placeholder="••••••••"
              {...register('password', { required: true })} />
          </div>
          {errors.root && <div style={s.alert}>{errors.root.message}</div>}
          <button type="submit" disabled={isSubmitting} style={s.btn}>
            {isSubmitting ? 'Signing in…' : 'Sign in →'}
          </button>
        </form>

        <p style={s.footer}>
          No account? <Link to="/register" style={s.link}>Create one</Link>
        </p>
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', padding: 16 },
  card: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 380, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' },
  logo: { fontSize: '2rem', marginBottom: 8 },
  title: { margin: '0 0 4px', fontSize: '1.5rem', fontWeight: 700, color: '#0f172a' },
  subtitle: { margin: '0 0 28px', color: '#64748b', fontSize: '0.875rem' },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: '0.8rem', fontWeight: 600, color: '#374151' },
  input: { padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: '0.9rem', outline: 'none', color: '#0f172a', transition: 'border-color 0.15s' },
  alert: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', color: '#dc2626', fontSize: '0.83rem' },
  btn: { marginTop: 4, padding: '11px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' },
  footer: { textAlign: 'center', marginTop: 20, fontSize: '0.83rem', color: '#64748b' },
  link: { color: '#2563eb', fontWeight: 600 },
};
