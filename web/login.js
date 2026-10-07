document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector("#login-error");
  error.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
    });
    if (!response.ok) throw new Error("Username atau password salah.");
    window.location.replace("/");
  } catch (cause) {
    error.textContent = cause.message;
    button.disabled = false;
  }
});
