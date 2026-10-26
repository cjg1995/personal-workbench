import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/** Loads the existing IDEA server configuration and deploys its one selected context in memory. */
public final class WorkbenchTomcat {
    private static Object invoke(Object object, String name, Class<?>[] types, Object... args) throws Exception {
        try {
            Method method = object.getClass().getMethod(name, types);
            return method.invoke(object, args);
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw error;
        }
    }
    private static Object get(Object object, String name) throws Exception {
        return invoke(object, name, new Class<?>[0]);
    }
    public static void main(String[] args) {
        Object bootstrap = null;
        try {
            if (args.length != 3) throw new IllegalArgumentException("Expected context, deployment and context XML");
            String contextPath = "/".equals(args[0]) ? "" : args[0];
            File deployment = new File(args[1]).getCanonicalFile();
            File contextXml = new File(args[2]).getCanonicalFile();
            if (!new File(deployment, "WEB-INF").isDirectory() || !contextXml.isFile())
                throw new IllegalArgumentException("Existing deployment or context XML is missing");
            Class<?> bootstrapClass = Class.forName("org.apache.catalina.startup.Bootstrap");
            bootstrap = bootstrapClass.newInstance();
            invoke(bootstrap, "init", new Class<?>[0]);
            invoke(bootstrap, "setAwait", new Class<?>[]{boolean.class}, false);
            invoke(bootstrap, "init", new Class<?>[]{String[].class}, (Object) new String[]{"start"});
            Field daemonField = bootstrapClass.getDeclaredField("catalinaDaemon");
            daemonField.setAccessible(true);
            Object catalina = daemonField.get(bootstrap);
            Object server = get(catalina, "getServer");
            if (server == null) throw new IllegalStateException("Tomcat did not load server.xml");
            ClassLoader loader = catalina.getClass().getClassLoader();
            Class<?> containerType = Class.forName("org.apache.catalina.Container", true, loader);
            Class<?> listenerType = Class.forName("org.apache.catalina.LifecycleListener", true, loader);
            Object host = null;
            for (Object service : (Object[]) get(server, "findServices")) {
                Object engine = get(service, "getContainer");
                Object candidate = invoke(engine, "findChild", new Class<?>[]{String.class}, "localhost");
                if (candidate != null) {
                    if (host != null) throw new IllegalStateException("More than one localhost host is configured");
                    host = candidate;
                }
            }
            if (host == null) throw new IllegalStateException("Configured localhost host is missing");
            invoke(bootstrap, "start", new Class<?>[0]);
            System.out.println("WORKBENCH_TOMCAT_CONTAINER_STARTED " + args[0]);
            Object context = invoke(host, "findChild", new Class<?>[]{String.class}, contextPath);
            if (context == null && Boolean.FALSE.equals(get(host, "getDeployOnStartup"))) {
                context = Class.forName("org.apache.catalina.core.StandardContext", true, loader).newInstance();
                invoke(context, "setName", new Class<?>[]{String.class}, contextPath);
                invoke(context, "setPath", new Class<?>[]{String.class}, contextPath);
                invoke(context, "setDocBase", new Class<?>[]{String.class}, deployment.getPath());
                invoke(context, "setConfigFile", new Class<?>[]{java.net.URL.class}, contextXml.toURI().toURL());
                Object listener = Class.forName("org.apache.catalina.startup.ContextConfig", true, loader).newInstance();
                invoke(context, "addLifecycleListener", new Class<?>[]{listenerType}, listener);
                invoke(host, "addChild", new Class<?>[]{containerType}, context);
            }
            context = invoke(host, "findChild", new Class<?>[]{String.class}, contextPath);
            if (context == null || !"STARTED".equals(get(context, "getStateName")))
                throw new IllegalStateException("The selected web application did not start: " + contextPath);
            File actual = new File(String.valueOf(get(context, "getDocBase"))).getCanonicalFile();
            if (!actual.equals(deployment)) throw new IllegalStateException("The running deployment differs from the selected directory");
            System.out.println("WORKBENCH_TOMCAT_READY " + args[0]);
            get(server, "await");
            invoke(bootstrap, "stop", new Class<?>[0]);
        } catch (Throwable error) {
            error.printStackTrace(System.err);
            if (bootstrap != null) try { invoke(bootstrap, "stop", new Class<?>[0]); } catch (Throwable ignored) { }
            System.exit(1);
        }
    }
}
