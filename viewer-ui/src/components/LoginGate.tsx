import { useState, type FormEvent } from "react";
import { Box, Button, Paper, TextField, Typography } from "@mui/material";
import { PRIMARY } from "@/lib/palette";

/* The viewer is protected: until a valid token resolves to a session, nothing
 * else renders — no run list, no actions, no operator surface. The token lives in
 * this browser tab's sessionStorage only and is sent solely to this viewer. */
export function LoginGate({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (token: string) => void;
}) {
  const [token, setToken] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(token);
  };

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        bgcolor: "background.default",
      }}
    >
      <Paper elevation={3} sx={{ maxWidth: 420, width: "100%", p: 4 }}>
        <Typography variant="h6" component="h1" sx={{ color: PRIMARY, fontWeight: 700, mb: 1 }}>
          ai-flow
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          This viewer is protected. Enter your token from <code>ai-flow.config.json</code> (the{" "}
          <code>auth.tokens</code> map, or the legacy <code>ui.token</code>). It is kept in this browser tab only
          (sessionStorage) and never sent anywhere but this viewer.
        </Typography>
        <Box component="form" onSubmit={submit}>
          <TextField
            autoFocus
            fullWidth
            type="password"
            label="Token"
            value={token}
            error={error !== null}
            helperText={error ?? ""}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button
            type="submit"
            variant="contained"
            fullWidth
            sx={{ mt: 2, fontWeight: 700 }}
            disabled={!token.trim() || busy}
          >
            {busy ? "Checking…" : "Sign in"}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
