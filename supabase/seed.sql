-- Auth accounts must be created by scripts/setup-dev.js first.
-- No auth.users insertion and no embedded passwords.
insert into public.properties(title,description,location,price,type,area,area_unit) select 'Park View Residence','Development sample property','Islamabad',25000000,'House',10,'marla' where not exists(select 1 from public.properties where title='Park View Residence');
