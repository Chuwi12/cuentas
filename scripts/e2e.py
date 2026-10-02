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
def raw(p,auth=True):
    """GET sin decodificar JSON: devuelve (status, headers, bytes)."""
    o=op if auth else urllib.request.build_opener()
    try:
        with o.open(urllib.request.Request(B+p)) as x: return x.status,x.headers,x.read()
    except urllib.error.HTTPError as e: return e.code,e.headers,e.read()
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

# ---- Informes ----
TODAY=datetime.date.today(); LASTD=calendar.monthrange(TODAY.year,TODAY.month)[1]
s,R=req("GET",f"/reports?period=month&date={D}")
check("informe mes: periodo completo",s==200 and R["period"]=={"kind":"month","from":M+"-01","to":f"{M}-{LASTD:02d}"},R.get("period") if s==200 else (s,R))
check("informe: totales (ingreso 2100, gasto 1790, neto 310, 7 mov., ahorro 14,76 %)",R["totals"]=={"income_cents":210000,"expense_cents":179000,"net_cents":31000,"transaction_count":7,"savings_rate_bp":1476},R["totals"])
check("informe: periodo anterior (mes previo, gasto 123,45, sin ingresos -> tasa null)",R["previous"]["period"]["from"]==PREV+"-01" and R["previous"]["totals"]=={"income_cents":0,"expense_cents":12345,"net_cents":-12345,"transaction_count":1,"savings_rate_bp":None},R["previous"])
check("informe: serie con todos los días del mes",len(R["series"])==LASTD and R["series"][0]["from"]==M+"-01" and R["series"][-1]["to"]==f"{M}-{LASTD:02d}",len(R["series"]))
check("informe: serie suma los totales y el día 10 concentra todo",sum(x["expense_cents"] for x in R["series"])==179000 and sum(x["income_cents"] for x in R["series"])==210000 and R["series"][9]["expense_cents"]==179000,R["series"][9])
bc=R["by_category"]
check("por categoría: orden desc, Nómina 100 % de ingresos, Alquiler 44,69 % de gastos",bc[0]["name"]=="Nómina" and bc[0]["share_bp"]==10000 and bc[1]["name"]=="Alquiler" and bc[1]["amount_cents"]==80000 and bc[1]["share_bp"]==4469 and all(bc[i]["amount_cents"]>=bc[i+1]["amount_cents"] for i in range(len(bc)-1)),bc)
unc=[c for c in bc if c["category_id"] is None]
check("por categoría: sin categoría con nombre, color y cubo null",len(unc)==1 and unc[0]["name"]=="Sin categoría" and unc[0]["color"]=="#9ca3af" and unc[0]["bucket"] is None and unc[0]["amount_cents"]==5000,unc)
bu=R["buckets"]
check("cubos: 4 filas en orden",[x["bucket"] for x in bu]==["needs","wants","savings",None],bu)
check("cubos: importes, objetivos y % de ingresos",[(x["amount_cents"],x["target_cents"],x["income_share_bp"]) for x in bu]==[(114000,105000,5429),(40000,63000,1905),(20000,42000,952),(5000,None,238)],bu)
tt=R["top_transactions"]
check("top: 7 movimientos, mayor primero, con categoría",len(tt)==7 and tt[0]["amount_cents"]==210000 and tt[0]["category_name"]=="Nómina" and tt[1]["description"] is None,tt[:2])
codes=[i["code"] for i in R["insights"]]
check("insights esperados y en orden",codes==["savings_rate","expense_change","top_category","bucket_over","largest_expense","daily_average","uncategorized"],codes)
ins={i["code"]:i for i in R["insights"]}
check("insight: ahorro 15 % (info) y gasto sube (warning)",ins["savings_rate"]["level"]=="info" and "15 %" in ins["savings_rate"]["message"] and ins["expense_change"]["level"]=="warning",ins)
check("insight: dinero en formato español",ins["top_category"]["message"]=="Alquiler concentra el 45 % del gasto (800,00 €)." and ins["uncategorized"]["message"]=="Hay 50,00 € en gastos sin categoría.",ins["top_category"])

s,E=req("GET",f"/reports?period=month&date={D}&scope=expenses")
check("scope=expenses: sin ingresos en categorías/top/serie, totales completos",s==200 and all(c["kind"]=="expense" for c in E["by_category"]) and all(t["kind"]=="expense" for t in E["top_transactions"]) and all(x["income_cents"]==0 for x in E["series"]) and E["totals"]["income_cents"]==210000,(s,E.get("totals")))
s,I=req("GET",f"/reports?period=month&date={D}&scope=income")
check("scope=income: solo ingresos, insights intactos",s==200 and [c["name"] for c in I["by_category"]]==["Nómina"] and len(I["top_transactions"])==1 and all(x["expense_cents"]==0 for x in I["series"]) and any(i["code"]=="largest_expense" for i in I["insights"]),(s,I.get("by_category")))
s,W=req("GET",f"/reports?period=week&date={D}")
wf=datetime.date.fromisoformat(W["period"]["from"]); wt=datetime.date.fromisoformat(W["period"]["to"])
check("semana ISO: lunes a domingo con 7 días",wf.weekday()==0 and (wt-wf).days==6 and len(W["series"])==7 and wf<=datetime.date.fromisoformat(D)<=wt,W["period"])
check("semana: sin regla de cubos",not any(i["code"]=="bucket_over" for i in W["insights"]))
s,Y=req("GET",f"/reports?period=year&date={D}")
check("año: 12 meses, enero a diciembre",s==200 and len(Y["series"])==12 and Y["series"][0]["from"]==f"{TODAY.year}-01-01" and Y["series"][11]["to"]==f"{TODAY.year}-12-31",Y["series"][:1] if s==200 else (s,Y))
check("año: suma de la serie = gasto del año",sum(x["expense_cents"] for x in Y["series"])==Y["totals"]["expense_cents"])
s,Z=req("GET","/reports?period=month&date=2001-05-05")
check("periodo vacío: solo insight empty, serie a cero, cubos sin objetivo",s==200 and [i["code"] for i in Z["insights"]]==["empty"] and len(Z["series"])==31 and Z["by_category"]==[] and Z["top_transactions"]==[] and all(b["target_cents"] is None and b["income_share_bp"] is None and b["amount_cents"]==0 for b in Z["buckets"]) and Z["totals"]["savings_rate_bp"] is None,(s,Z))
s,Dflt=req("GET","/reports")
check("sin parámetros: mes actual, scope all",s==200 and Dflt["period"]["kind"]=="month" and Dflt["period"]["from"]==M+"-01" and Dflt["scope"]=="all",Dflt.get("period"))
for q in ["period=day","date=2026-13-40","date=1999-12-31","date=2101-01-01","date=ayer","scope=todo","period=","date=2026-9-1"]:
    s,b=req("GET","/reports?"+q); check(f"informe con {q} -> 422 validation",s==422 and b["error"]["code"]=="validation",(s,b))
s,_=req("GET","/reports",auth=False); check("informe sin sesión -> 401",s==401)
s,_,_=raw("/reports/export.csv",auth=False); check("csv sin sesión -> 401",s==401)

inj='=HYPERLINK("http://x.test";"a")'
s,b=tx("expense",1250,"Comida",desc=inj); check("alta gasto con descripción maliciosa",s==201,(s,b))
s,h,body=raw(f"/reports/export.csv?period=month&date={D}")
text=body.decode("utf-8"); lines=text.split("\r\n")
check("csv: 200 y cabeceras seguras",s==200 and h["Content-Type"]=="text/csv; charset=utf-8" and h["Cache-Control"]=="no-store" and h["X-Content-Type-Options"]=="nosniff" and h["Content-Disposition"]==f'attachment; filename="cuentas-all-month-{M}-01.csv"',dict(h))
check("csv: BOM, cabecera con ; y CRLF",body.startswith(b"\xef\xbb\xbf") and lines[0]=="\ufefffecha;tipo;categoría;cubo;descripción;importe" and lines[-1]=="" and "\n" not in text.replace("\r\n",""),lines[0])
check("csv: 8 movimientos + cabecera",len(lines)==10,len(lines))
check("csv: gasto en negativo con coma, ingreso positivo",f"{D};gasto;Alquiler;necesidades;;-800,00" in lines and f"{D};ingreso;Nómina;;Nómina septiembre;2100,00" in lines,lines)
check("csv: sin categoría",f"{D};gasto;Sin categoría;;;-50,00" in lines)
check("csv: fórmula neutralizada y comillas/; escapados",f'{D};gasto;Comida;necesidades;"\'=HYPERLINK(""http://x.test"";""a"")";-12,50' in lines,[l for l in lines if "HYPERLINK" in l])
s,h,body=raw(f"/reports/export.csv?period=month&date={D}&scope=income")
l2=body.decode().split("\r\n"); check("csv scope=income: 1 fila",s==200 and len(l2)==3 and l2[1].startswith(D+";ingreso;"),l2)
s,h,body=raw(f"/reports/export.csv?period=month&date={D}&detail=categories&scope=expenses")
l3=body.decode().split("\r\n")
check("csv categorías: cabecera y fila de Alquiler con %",l3[0]=="\ufeffcategoría;tipo;cubo;movimientos;importe;porcentaje" and "Alquiler;gasto;necesidades;1;-800,00;44,38" in l3 and not any(";ingreso;" in l for l in l3),l3)
for q in ["detail=otro","scope=x","period=decada"]:
    s,h,body=raw("/reports/export.csv?"+q); check(f"csv con {q} -> 422",s==422 and json.loads(body)["error"]["code"]=="validation",(s,body))
s,lst=req("GET",f"/transactions?q=HYPERLINK"); s,_=req("DELETE",f"/transactions/{lst['items'][0]['id']}"); check("limpieza del movimiento malicioso",s==204)

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
