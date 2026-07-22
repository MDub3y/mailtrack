import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface FormData { name: string; email: string; password: string; emailAddress: string; }

export const Register = () => {
  const { register: registerUser } = useAuth();
  const navigate = useNavigate();
  const { register, handleSubmit, formState: { errors, isSubmitting }, setError } = useForm<FormData>();

  const onSubmit = async (data: FormData) => {
    try { await registerUser(data); navigate('/sent'); }
    catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Registration failed';
      setError('root', { message: msg });
    }
  };

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.logo}>✉</div>
        <h1 style={s.title}>Create account</h1>
        <p style={s.subtitle}>Start tracking your emails</p>

        <form onSubmit={handleSubmit(onSubmit)} style={s.form}>
          <div style={s.field}>
            <label style={s.label}>Full name</label>
            <input style={s.input} type="text" placeholder="Alice Smith" {...register('name', { required: true })} />
          </div>
          <div style={s.field}>
            <label style={s.label}>Login email</label>
            <input style={s.input} type="email" placeholder="alice@gmail.com" {...register('email', { required: true })} />
          </div>
          <div style={s.field}>
            <label style={s.label}>
              Inbound address
              <span style={{ color: '#94a3b8', fontWeight: 400, marginLeft: 4 }}>(your @yourdomain.com)</span>
            </label>
            <input style={s.input} type="email" placeholder="alice@yourdomain.com" {...register('emailAddress', { required: true })} />
          </div>
          <div style={s.field}>
            <label style={s.label}>Password</label>
            <input style={s.input} type="password" placeholder="Min 6 characters" {...register('password', { required: true, minLength: 6 })} />
            {errors.password?.type === 'minLength' && <span style={s.hint}>Min 6 characters</span>}
          </div>

          {errors.root && <div style={s.alert}>{errors.root.message}</div>}

          <button type="submit" disabled={isSubmitting} style={s.btn}>
            {isSubmitting ? 'Creating account…' : 'Create account →'}
          </button>
        </form>

        <p style={s.footer}>
          Already have an account? <Link to="/login" style={s.link}>Sign in</Link>
        </p>
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', padding: 16 },
  card: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 400, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' },
  logo: { fontSize: '2rem', marginBottom: 8 },
  title: { margin: '0 0 4px', fontSize: '1.5rem', fontWeight: 700, color: '#0f172a' },
  subtitle: { margin: '0 0 28px', color: '#64748b', fontSize: '0.875rem' },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: '0.8rem', fontWeight: 600, color: '#374151' },
  input: { padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: '0.9rem', outline: 'none', color: '#0f172a' },
  hint: { fontSize: '0.72rem', color: '#ef4444' },
  alert: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', color: '#dc2626', fontSize: '0.83rem' },
  btn: { marginTop: 4, padding: '11px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' },
  footer: { textAlign: 'center', marginTop: 20, fontSize: '0.83rem', color: '#64748b' },
  link: { color: '#2563eb', fontWeight: 600 },
};
