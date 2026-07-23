import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface FormData {
  email: string;
  password: string;
}

export const Login = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<FormData>();

  const onSubmit = async (data: FormData) => {
    try {
      await login(data.email, data.password);
      navigate('/sent');
    } catch {
      setError('root', { message: 'Invalid email or password' });
    }
  };

  return (
    <div className="min-h-screen bg-[#ffffff] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-[#eaedf1] bg-[#ffffff] p-8 md:p-10 shadow-sm relative overflow-hidden">
        {/* Top Header */}
        <div className="flex flex-col items-center text-center mb-8">
          <div className="flex items-center justify-center size-10 rounded-xl border border-[#eaedf1] bg-[#f8fafc] text-[#0f172a] shadow-sm mb-3">
            <svg width="20" height="24" viewBox="0 0 20 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M0 4.5C0 3.11929 1.11929 2 2.5 2H7.5C8.88071 2 10 3.11929 10 4.5V9.40959C10.0001 9.4396 10.0002 9.46975 10.0002 9.50001C10.0002 10.8787 11.1162 11.9968 12.4942 12C12.4961 12 12.4981 12 12.5 12H17.5C18.8807 12 20 13.1193 20 14.5V19.5C20 20.8807 18.8807 22 17.5 22H12.5C11.1193 22 10 20.8807 10 19.5V14.5C10 14.4931 10 14.4861 10.0001 14.4792C9.98891 13.1081 8.87394 12 7.50017 12C7.4937 12 7.48725 12 7.48079 12H2.5C1.11929 12 0 10.8807 0 9.5V4.5Z" fill="currentColor" />
            </svg>
          </div>
          <span className="text-[9px] font-mono font-bold tracking-[0.25em] text-[#F17463] uppercase">
            MXDUB
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-[#0f172a] mt-1">
            Welcome back to MailTrack
          </h1>
          <p className="text-xs text-[#64748b] mt-1">Enter your details to sign in</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[#0f172a] mb-1.5">
              Login Email
            </label>
            <input
              type="email"
              placeholder="you@example.com"
              {...register('email', { required: true })}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#eaedf1] bg-[#f8fafc] text-sm text-[#0f172a] placeholder-[#94a3b8] outline-none focus:border-[#0f172a] focus:bg-[#ffffff] transition-all"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#0f172a] mb-1.5">
              Password
            </label>
            <input
              type="password"
              placeholder="••••••••"
              {...register('password', { required: true })}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#eaedf1] bg-[#f8fafc] text-sm text-[#0f172a] placeholder-[#94a3b8] outline-none focus:border-[#0f172a] focus:bg-[#ffffff] transition-all"
            />
          </div>

          {errors.root && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs font-medium text-red-600">
              {errors.root.message}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-2.5 px-4 rounded-xl bg-[#171717] hover:bg-[#000000] text-white text-sm font-medium transition duration-150 active:scale-[0.98] cursor-pointer"
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="mt-8 text-center text-xs text-[#64748b]">
          Don't have an account?{' '}
          <Link to="/register" className="font-semibold text-[#F17463] hover:underline">
            Create one
          </Link>
        </div>
      </div>
    </div>
  );
};