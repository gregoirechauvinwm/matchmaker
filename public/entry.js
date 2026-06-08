// public/entry.js
// Drives the entry flow on the client side: sets up the phone field, calls the
// auth endpoints, swaps between the phone and code screens, and routes to the
// chat once logged in.

const phoneScreen = document.getElementById('phone-screen');
const codeScreen = document.getElementById('code-screen');
const phoneInput = document.getElementById('phone');
const phoneContinue = document.getElementById('phone-continue');
const phoneError = document.getElementById('phone-error');
const codeInput = document.getElementById('code');
const codeContinue = document.getElementById('code-continue');
const codeBack = document.getElementById('code-back');
const codeError = document.getElementById('code-error');
const codeSubtitle = document.getElementById('code-subtitle');

// If already logged in, skip straight to the chat (which resumes the flow).
async function routeIfLoggedIn() {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    if (data.authenticated) {
      window.location.href = '/chat';
    }
  } catch {
    // ignore; show the phone screen
  }
}
routeIfLoggedIn();

// Set up intl-tel-input: US default, full country dropdown with flags + search.
const iti = window.intlTelInput(phoneInput, {
  initialCountry: 'us',
  separateDialCode: true,
  // Loads the per-country example formats; lets us validate as the user types.
  utilsScript: 'https://cdn.jsdelivr.net/npm/intl-tel-input@24.6.0/build/js/utils.js',
});

let pendingPhone = null;   // normalized phone returned by the server
let pendingCountry = 'US';

phoneContinue.addEventListener('click', async () => {
  phoneError.textContent = '';
  const raw = phoneInput.value.trim();
  const country = (iti.getSelectedCountryData().iso2 || 'us').toUpperCase();

  if (!iti.isValidNumber()) {
    phoneError.textContent = 'Please enter a valid phone number.';
    return;
  }

  phoneContinue.disabled = true;
  try {
    const res = await fetch('/auth/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: raw, country }),
    });
    const data = await res.json();
    if (!res.ok) {
      phoneError.textContent = 'Please enter a valid phone number.';
      return;
    }
    pendingPhone = data.phone;
    pendingCountry = country;

    // Show the code screen. In dev, nudge the tester toward 000.
    if (data.dev) {
      codeSubtitle.textContent = 'Dev mode: enter 000 to continue.';
    }
    phoneScreen.style.display = 'none';
    codeScreen.style.display = 'flex';
    codeInput.focus();
  } catch {
    phoneError.textContent = 'Something went wrong. Try again.';
  } finally {
    phoneContinue.disabled = false;
  }
});

codeContinue.addEventListener('click', async () => {
  codeError.textContent = '';
  const code = codeInput.value.trim();
  if (!code) {
    codeError.textContent = 'Enter the code.';
    return;
  }

  codeContinue.disabled = true;
  try {
    const res = await fetch('/auth/confirm-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: pendingPhone, country: pendingCountry, code }),
    });
    if (!res.ok) {
      codeError.textContent = 'That code is not correct.';
      return;
    }
    // Logged in. Go to the chat (Step 3 builds the actual chat screen).
    window.location.href = '/chat';
  } catch {
    codeError.textContent = 'Something went wrong. Try again.';
  } finally {
    codeContinue.disabled = false;
  }
});

codeBack.addEventListener('click', () => {
  codeScreen.style.display = 'none';
  phoneScreen.style.display = 'flex';
  codeInput.value = '';
  codeError.textContent = '';
});
