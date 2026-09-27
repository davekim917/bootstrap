-- leading comment
select 'it''s -- not a comment' as a, -- trailing
       e'escaped \' -- still string' as b
/* block
   /* nested */
   still block */
from t;
