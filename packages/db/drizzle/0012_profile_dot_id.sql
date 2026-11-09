ALTER TABLE "profiles" ADD COLUMN "dot_id" varchar(32);
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_dot_id_unique" UNIQUE("dot_id");
