create function f() returns int as $body$
begin
  -- comment inside the function body
  return 1; /* and a block */
end
$body$ language plpgsql;
select $$ -- dollar-quoted text is lexed as sql $$;
select $1, x$y from t;
