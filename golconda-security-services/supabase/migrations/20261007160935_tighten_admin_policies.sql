-- Use the authenticated user's own admin_users row for RLS checks. This avoids
-- exposing SECURITY DEFINER helpers through the public PostgREST RPC surface.
revoke all on function public.is_admin() from public, anon, authenticated;
revoke all on function public.rls_auto_enable() from public, anon, authenticated;

drop policy if exists "Admins manage services" on public.services;
create policy "Admins insert services" on public.services
  for insert to authenticated
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));
create policy "Admins update services" on public.services
  for update to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));
create policy "Admins delete services" on public.services
  for delete to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

drop policy if exists "Admins manage events" on public.events;
create policy "Admins insert events" on public.events
  for insert to authenticated
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));
create policy "Admins update events" on public.events
  for update to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));
create policy "Admins delete events" on public.events
  for delete to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

drop policy if exists "Admins manage notifications" on public.notifications;
create policy "Admins insert notifications" on public.notifications
  for insert to authenticated
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));
create policy "Admins update notifications" on public.notifications
  for update to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));
create policy "Admins delete notifications" on public.notifications
  for delete to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

drop policy if exists "Admins manage sites" on public.sites;
create policy "Admins manage sites" on public.sites
  for all to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

drop policy if exists "Admins manage guards" on public.guards;
create policy "Admins manage guards" on public.guards
  for all to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

drop policy if exists "Admins manage complaints" on public.complaints;
create policy "Admins manage complaints" on public.complaints
  for all to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

drop policy if exists "Admins manage contact submissions" on public.contact_submissions;
create policy "Admins manage contact submissions" on public.contact_submissions
  for all to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

drop policy if exists "Admins manage job applications" on public.job_applications;
create policy "Admins manage job applications" on public.job_applications
  for all to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

drop policy if exists "Admins manage profile docs" on public.profile_docs;
create policy "Admins manage profile docs" on public.profile_docs
  for all to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))
  with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));
