-- Откат 20261015160000_launch_category_first: ЗАГС снова первым, залы — вторыми; повод «small» —
-- прежним названием

update app.categories set sort = 1 where code = 'zags';
update app.categories set sort = 2 where code = 'hall';

update app.occasions
   set name_ru = 'Частное', name_uz = 'Yopiq davra'
 where code = 'small';
