-- next_step se retira de la app. No era un dato que nadie hubiera escrito: al
-- migrar el Excel lo rellené cortando la primera frase de cada nota, y esa nota
-- sigue íntegra en account_notes. La columna ancha de la tabla la ocupa ahora
-- la última nota, que es lo que de verdad se consulta.
alter table public.accounts drop column next_step;
