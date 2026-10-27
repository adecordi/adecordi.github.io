# Certificato di prova già scaduto (2020-2022), firmato dalla CA di prova.
import datetime
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
ca_key = serialization.load_pem_private_key(open("ca.key","rb").read(), None)
ca = x509.load_pem_x509_certificate(open("ca.crt","rb").read())
key = serialization.load_pem_private_key(open("old.key","rb").read(), None)
name = x509.Name([x509.NameAttribute(NameOID.COUNTRY_NAME,"IT"), x509.NameAttribute(NameOID.COMMON_NAME,"VERDI GIUSEPPE"), x509.NameAttribute(NameOID.SURNAME,"VERDI"), x509.NameAttribute(NameOID.GIVEN_NAME,"GIUSEPPE"), x509.NameAttribute(NameOID.SERIAL_NUMBER,"TINIT-VRDGPP70A01L219K")])
c = (x509.CertificateBuilder().subject_name(name).issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
     .not_valid_before(datetime.datetime(2020,1,1)).not_valid_after(datetime.datetime(2022,1,1))
     .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), False).sign(ca_key, hashes.SHA256()))
open("old.crt","wb").write(c.public_bytes(serialization.Encoding.PEM))
