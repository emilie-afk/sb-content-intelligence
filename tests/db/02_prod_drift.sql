-- TEST ONLY: columns production has that committed migrations expect but never add.
alter table discovery_clusters add column if not exists maintenance_status text;
