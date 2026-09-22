"""Prueba de punta a punta de la API contra una BD real.

Uso: con el backend arrancado sobre una BD VACÍA (sin usuario),
    python3 scripts/e2e.py [http://127.0.0.1:8080/api]

Crea el usuario yo@example.com y datos de prueba. Se niega a ejecutarse si ya
existe un usuario, para no tocar nunca tus datos reales. Para repetirla:
    podman exec finanzas-db psql -U finanzas -d finanzas -c 'delete from users'
"""
import json, urllib.request, http.cookiejar, datetime, calendar, sys
B=sys.argv[1] if len(sys.argv)>1 else "http://127.0.0.1:8080/api"
jar=http.cookiejar.CookieJar(); op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
fails=0
def req(m,p,body=None,auth=True):
    r=urllib.request.Request(B+p,method=m,data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type":"application/json"} if body is not None else {})
    o=op if auth else urllib.request.build_opener()
    try:
        with o.open(r) as x: t=x.read(); return x.status,(json.loads(t) if t else None)
    except urllib.error.HTTPError as e: t=e.read(); return e.code,(json.loads(t) if t else None)
def check(name,cond,extra=""):
    global fails
    print(("OK   " if cond else "FALLA"),name,"" if cond else extra)
    if not cond: fails+=1
M=datetime.date.today().strftime("%Y-%m"); D=M+"-10"
PREV=(datetime.date.today().replace(day=1)-datetime.timedelta(days=1)).strftime("%Y-%m")

s,b=req("GET","/auth/status")
if s!=200 or not b["registration_open"]:
    sys.exit("Abortado: la BD ya tiene un usuario. Esta prueba solo corre sobre una BD vacía.")
check("status abierto",True)
s,b=req("POST","/auth/register",{"email":"yo@example.com","password":"corta"}); check("password corta -> 422",s==422,(s,b))
s,b=req("POST","/auth/register",{"email":"  Yo@Example.com ","password":"una-contraseña-larga"}); check("registro 201",s==201 and b["user"]["email"]=="yo@example.com",(s,b))
check("no filtra hash","password_hash" not in json.dumps(b))
ck=[c for c in jar if c.name=="auth_token"]; check("cookie httpOnly",ck and ck[0].has_nonstandard_attr("HttpOnly"),[ (c.name,c._rest) for c in jar])
s,b=req("POST","/auth/register",{"email":"otro@example.com","password":"otra-contraseña-larga"},auth=False); check("segundo registro 403",s==403 and b["error"]["code"]=="registration_closed",(s,b))
s,b=req("GET","/auth/status"); check("status cerrado",b["registration_open"] is False)
s,_=req("GET","/auth/me",auth=False); check("me sin cookie 401",s==401)
s,b=req("GET","/auth/me"); check("me con cookie 200",s==200)

s,cats=req("GET","/categories"); check("10 categorías sembradas",s==200 and len(cats)==10,(s,cats))
C={c["name"]:c for c in cats}
check("gym en deseos, inversión en ahorro",C["Gym"]["bucket"]=="wants" and C["Inversión"]["bucket"]=="savings")
check("ingreso sin cubo",C["Nómina"]["bucket"] is None)

def tx(kind,cents,cat,day=D,desc=None): return req("POST","/transactions",{"kind":kind,"amount_cents":cents,"category_id":C[cat]["id"] if cat else None,"occurred_on":day,"description":desc})
s,b=tx("income",210000,"Nómina",desc="Nómina septiembre"); check("alta ingreso 201 con categoría incrustada",s==201 and b["category"]["name"]=="Nómina",(s,b))
for k,c,cat in [("expense",80000,"Alquiler"),("expense",30000,"Comida"),("expense",40000,"Ocio"),("expense",4000,"Gym"),("expense",20000,"Inversión"),("expense",5000,None)]:
    s,b=tx(k,c,cat); check(f"alta gasto {cat}",s==201,(s,b))
s,b=tx("expense",1000,"Nómina"); check("gasto con categoría de ingreso -> 422",s==422,(s,b))
s,b=req("POST","/transactions",{"kind":"expense","amount_cents":0,"category_id":None,"occurred_on":D}); check("importe 0 -> 422",s==422,(s,b))
tx("expense",12345,"Comida",day=PREV+"-15")

s,S=req("GET",f"/summary?month={M}"); bk={x["bucket"]:x for x in S["buckets"]}
check("ingreso 2100",S["income_cents"]==210000,S)
check("gasto total 1790 (incluye sin categoría)",S["expense_cents"]==179000,S["expense_cents"])
check("necesidades 1100 / obj 1050 / +50",(bk["needs"]["actual_cents"],bk["needs"]["target_cents"],bk["needs"]["delta_cents"])==(110000,105000,5000),bk["needs"])
check("deseos 440 / obj 630",(bk["wants"]["actual_cents"],bk["wants"]["target_cents"])==(44000,63000),bk["wants"])
check("ahorro = 200 inversión + 310 sobrante = 510",bk["savings"]["actual_cents"]==51000,bk["savings"])
check("sin categoría 50",S["uncategorized_expense_cents"]==5000)
check("pct necesidades 52.4",bk["needs"]["actual_pct"]==52.4,bk["needs"]["actual_pct"])

s,b=req("PATCH",f"/categories/{C['Gym']['id']}",{"bucket":"needs"}); check("mover gym a necesidades",s==200 and b["bucket"]=="needs",(s,b))
s,S=req("GET",f"/summary?month={M}"); bk={x["bucket"]:x for x in S["buckets"]}
check("tras mover gym: necesidades 1140, deseos 400",(bk["needs"]["actual_cents"],bk["wants"]["actual_cents"])==(114000,40000),(bk["needs"],bk["wants"]))
s,b=req("PATCH",f"/categories/{C['Nómina']['id']}",{"bucket":"needs"}); check("ingreso con cubo -> 422",s==422,(s,b))
s,b=req("POST","/categories",{"name":" comida ","kind":"expense","bucket":"needs"}); check("nombre duplicado -> 409",s==409,(s,b))

s,T=req("GET","/summary/trend?months=3"); pts=T["points"]
check("trend 3 meses ascendente",len(pts)==3 and pts[-1]["month"]==M and pts[0]["month"]<pts[1]["month"],pts)
check("trend coherente con resumen",pts[-1]["savings_cents"]==51000 and pts[-1]["needs_cents"]==114000,pts[-1])
check("mes anterior: 123,45 en necesidades y ahorro 0",pts[1]["needs_cents"]==12345 and pts[1]["savings_cents"]==0,pts[1])
s,b=req("GET","/summary?month=2026-13"); check("mes inválido -> 422",s==422,(s,b))

LAST=calendar.monthrange(datetime.date.today().year,datetime.date.today().month)[1]
s,L=req("GET",f"/transactions?from={M}-01&to={M}-{LAST}"); check("listado del mes: 7",L["total"]==7,L["total"])
s,L=req("GET","/transactions?bucket=needs"); check("filtro cubo necesidades: 4 (alquiler, comida x2, gym)",L["total"]==4,[ (i["category"]or{}).get("name") for i in L["items"]])
s,L=req("GET","/transactions?q=n%C3%B3mina"); check("búsqueda texto",L["total"]==1,L["total"])
s,L=req("GET","/transactions?q=100%25"); check("búsqueda con % escapado no casa todo",L["total"]==0,L["total"])
s,L=req("GET","/transactions?per_page=2&page=2"); check("paginación",len(L["items"])==2 and L["total"]==8,(len(L["items"]),L["total"]))

ocio=[i for i in req("GET","/transactions?per_page=200")[1]["items"] if (i["category"] or {}).get("name")=="Ocio"][0]
s,b=req("PATCH",f"/transactions/{ocio['id']}",{"description":"Concierto"}); check("patch parcial conserva categoría",s==200 and b["category_id"]==ocio["category_id"] and b["description"]=="Concierto",b)
s,b=req("PATCH",f"/transactions/{ocio['id']}",{"category_id":None}); check("patch null explícito quita categoría",s==200 and b["category_id"] is None,b)
s,_=req("DELETE",f"/categories/{C['Comida']['id']}"); check("borrar categoría 204",s==204)
s,L=req("GET","/transactions?per_page=200"); check("movimientos de Comida quedan sin categoría",sum(1 for i in L["items"] if i["category_id"] is None)==4,None)
s,_=req("DELETE",f"/transactions/{ocio['id']}"); check("borrar movimiento 204",s==204)
s,_=req("DELETE",f"/transactions/{ocio['id']}"); check("borrar dos veces 404",s==404)

s,_=req("POST","/auth/logout"); s2,_=req("GET","/auth/me"); check("logout invalida sesión",s==204 and s2==401,(s,s2))
s,b=req("POST","/auth/login",{"email":"yo@example.com","password":"mala-contraseña-x"}); check("login mala 401 invalid_credentials",s==401 and b["error"]["code"]=="invalid_credentials",(s,b))
s,b=req("POST","/auth/login",{"email":"nadie@example.com","password":"mala-contraseña-x"}); check("login usuario inexistente: mismo error",s==401 and b["error"]["code"]=="invalid_credentials",(s,b))
s,b=req("POST","/auth/login",{"email":"YO@example.com","password":"una-contraseña-larga"}); check("login ok (email sin distinguir mayúsculas)",s==200,(s,b))
print(f"\n{'TODO OK' if not fails else f'{fails} FALLOS'}")
sys.exit(1 if fails else 0)
