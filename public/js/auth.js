/*
 * Login page script:
 * - Validates login form inputs.
 * - Calls backend authentication endpoint.
 * - Stores token/user in localStorage and redirects by role.
 */

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  if (!form) return;

  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const rememberMeInput = document.getElementById('rememberMe');
  const toggleBtn = document.getElementById('togglePassword');
  const submitBtn = document.getElementById('loginSubmitBtn');
  const forgotPasswordLink = document.getElementById('forgotPasswordLink');
  const loginStatus = document.getElementById('loginStatus');

  const emailError = document.getElementById('emailError');
  const passwordError = document.getElementById('passwordError');

  const rememberedEmail = localStorage.getItem('rememberedEmail');
  if (rememberedEmail) {
    emailInput.value = rememberedEmail;
    if (rememberMeInput) rememberMeInput.checked = true;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('reason') === 'session_expired' && loginStatus) {
    loginStatus.textContent = 'Your session expired. Please sign in again.';
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const icon = toggleBtn.querySelector('i');
      const showing = passwordInput.type === 'text';
      passwordInput.type = showing ? 'password' : 'text';
      toggleBtn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      if (!icon) return;
      icon.classList.toggle('bi-eye', !showing);
      icon.classList.toggle('bi-eye-slash', showing);
    });
  }

  if (forgotPasswordLink) {
    forgotPasswordLink.addEventListener('click', (e) => {
      e.preventDefault();
      showToast('Please contact the system administrator to reset your password.', 'warning');
    });
  }

  const setSubmitting = (isSubmitting) => {
    if (!submitBtn) return;
    submitBtn.disabled = isSubmitting;
    submitBtn.textContent = isSubmitting ? 'Signing in...' : 'Sign In';
  };

  const clearErrors = () => {
    if (emailError) emailError.textContent = '';
    if (passwordError) passwordError.textContent = '';
  };

  const setValidationErrors = (emailMessage, passwordMessage) => {
    if (emailError) emailError.textContent = emailMessage || '';
    if (passwordError) passwordError.textContent = passwordMessage || '';
  };

  let failedAttempts = 0;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();

    const emailVal = emailInput.value.trim();
    const passwordVal = passwordInput.value;
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    let hasError = false;
    let validationToast = '';

    if (!emailVal) {
      setValidationErrors('Email is required', '');
      hasError = true;
      validationToast = 'Please enter your email.';
    } else if (!emailPattern.test(emailVal)) {
      setValidationErrors('Please enter a valid email address', '');
      hasError = true;
      validationToast = 'Please enter a valid email address.';
    }

    if (!passwordVal) {
      setValidationErrors(emailError?.textContent || '', 'Password is required');
      hasError = true;
      validationToast = validationToast || 'Please enter your password.';
    }

    if (!emailVal && !passwordVal) {
      validationToast = 'Please enter your email and password.';
    }

    if (hasError) {
      showToast(validationToast || 'Please complete required fields.', 'error');
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailVal, password: passwordVal })
      });

      const data = await res.json();

      if (!res.ok) {
        failedAttempts += 1;

        if (res.status === 403) {
          const backendMsg = (data?.error || '').toLowerCase();
          if (backendMsg.includes('account') && backendMsg.includes('inactive')) {
            throw new Error('This account is inactive. Please contact the Director.');
          }
          if (backendMsg.includes('branch') && backendMsg.includes('inactive')) {
            throw new Error('Your branch is inactive. Please contact the Director.');
          }
          throw new Error(data?.error || 'Access denied. Please contact the Director.');
        }

        if (res.status === 400) {
          throw new Error('Please enter your email and password.');
        }

        if (res.status === 401) {
          throw new Error('Email or password is incorrect.');
        }

        if (failedAttempts >= 3) {
          throw new Error('Email or password is incorrect. Please try again.');
        }
        throw new Error('Email or password is incorrect.');
      }

      failedAttempts = 0;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));

      if (rememberMeInput?.checked) {
        localStorage.setItem('rememberedEmail', emailVal);
      } else {
        localStorage.removeItem('rememberedEmail');
      }

      const fullName = data.user.full_name || 'User';
      showToast(`Welcome, ${fullName}!`, 'success');

      const role = data.user.role;
      setTimeout(() => {
        if (role === 'director') {
          window.location.href = 'pages/director/dashboard.html';
        } else if (role === 'manager') {
          window.location.href = 'pages/manager/dashboard.html';
        } else {
          window.location.href = 'pages/sales/dashboard.html';
        }
      }, 900);
    } catch (err) {
      showToast(err.message || 'Login failed', 'error');
    } finally {
      setSubmitting(false);
    }
  });
});
