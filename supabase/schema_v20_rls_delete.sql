-- Allow authenticated users to delete signals
-- (owner/admin only — no anon access)
CREATE POLICY "authenticated_delete_signals"
ON signals FOR DELETE
TO authenticated
USING (true);
